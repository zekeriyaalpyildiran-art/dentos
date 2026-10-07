'use client';

import { useState } from 'react';

interface ClinicSettings {
  name: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  country: string;
  tax_id: string;
  working_hours_start: string;
  working_hours_end: string;
  appointment_duration: number;
  cancellation_window: number;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<ClinicSettings>({
    name: 'Klinik Merkezi',
    phone: '+90 (555) 100-0001',
    email: 'info@klinikmerkezi.com.tr',
    address: 'İstanbul, Türkiye',
    city: 'İstanbul',
    country: 'Turkey',
    tax_id: '1234567890',
    working_hours_start: '09:00',
    working_hours_end: '18:00',
    appointment_duration: 30,
    cancellation_window: 24,
  });

  const [saved, setSaved] = useState(false);
  const [activeTab, setActiveTab] = useState<'general' | 'integrations' | 'notifications'>('general');

  const handleChange = (field: keyof ClinicSettings, value: any) => {
    setSettings({ ...settings, [field]: value });
    setSaved(false);
  };

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-2">⚙️ Klinik Ayarları</h1>
          <p className="text-gray-600">Klinik bilgilerini ve sistem ayarlarını yönet</p>
        </div>

        {/* Tabs */}
        <div className="bg-white rounded-lg shadow mb-8 border-b">
          <div className="flex">
            <button
              onClick={() => setActiveTab('general')}
              className={`px-6 py-4 font-semibold border-b-2 transition-all ${
                activeTab === 'general'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-700 hover:text-gray-900'
              }`}
            >
              📋 Genel Bilgiler
            </button>
            <button
              onClick={() => setActiveTab('integrations')}
              className={`px-6 py-4 font-semibold border-b-2 transition-all ${
                activeTab === 'integrations'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-700 hover:text-gray-900'
              }`}
            >
              🔌 Entegrasyonlar
            </button>
            <button
              onClick={() => setActiveTab('notifications')}
              className={`px-6 py-4 font-semibold border-b-2 transition-all ${
                activeTab === 'notifications'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-700 hover:text-gray-900'
              }`}
            >
              🔔 Bildirimler
            </button>
          </div>
        </div>

        {/* General Settings */}
        {activeTab === 'general' && (
          <div className="bg-white rounded-lg shadow p-8">
            <h2 className="text-2xl font-bold text-gray-900 mb-6">Klinik Bilgileri</h2>

            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-semibold text-gray-900 mb-2">
                    Klinik Adı
                  </label>
                  <input
                    type="text"
                    value={settings.name}
                    onChange={(e) => handleChange('name', e.target.value)}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold text-gray-900 mb-2">
                    Telefon
                  </label>
                  <input
                    type="tel"
                    value={settings.phone}
                    onChange={(e) => handleChange('phone', e.target.value)}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold text-gray-900 mb-2">
                    Email
                  </label>
                  <input
                    type="email"
                    value={settings.email}
                    onChange={(e) => handleChange('email', e.target.value)}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold text-gray-900 mb-2">
                    Vergi No (KDV)
                  </label>
                  <input
                    type="text"
                    value={settings.tax_id}
                    onChange={(e) => handleChange('tax_id', e.target.value)}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-semibold text-gray-900 mb-2">
                  Adres
                </label>
                <input
                  type="text"
                  value={settings.address}
                  onChange={(e) => handleChange('address', e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div className="grid grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-semibold text-gray-900 mb-2">
                    Şehir
                  </label>
                  <input
                    type="text"
                    value={settings.city}
                    onChange={(e) => handleChange('city', e.target.value)}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold text-gray-900 mb-2">
                    Ülke
                  </label>
                  <input
                    type="text"
                    value={settings.country}
                    onChange={(e) => handleChange('country', e.target.value)}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <h3 className="font-semibold text-gray-900 mb-3">⏰ Çalışma Saatleri</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-semibold text-gray-900 mb-2">
                      Açılış Saati
                    </label>
                    <input
                      type="time"
                      value={settings.working_hours_start}
                      onChange={(e) => handleChange('working_hours_start', e.target.value)}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-semibold text-gray-900 mb-2">
                      Kapanış Saati
                    </label>
                    <input
                      type="time"
                      value={settings.working_hours_end}
                      onChange={(e) => handleChange('working_hours_end', e.target.value)}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>
                </div>
              </div>

              <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
                <h3 className="font-semibold text-gray-900 mb-3">📋 Randevu Ayarları</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-semibold text-gray-900 mb-2">
                      Varsayılan Süre (dakika)
                    </label>
                    <input
                      type="number"
                      value={settings.appointment_duration}
                      onChange={(e) => handleChange('appointment_duration', parseInt(e.target.value))}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-semibold text-gray-900 mb-2">
                      İptal Penceresi (saat)
                    </label>
                    <input
                      type="number"
                      value={settings.cancellation_window}
                      onChange={(e) => handleChange('cancellation_window', parseInt(e.target.value))}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-8 flex gap-4">
              <button
                onClick={handleSave}
                className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-semibold transition-all"
              >
                💾 Kaydet
              </button>
              {saved && (
                <div className="flex items-center gap-2 text-green-600 font-semibold">
                  ✓ Ayarlar kaydedildi
                </div>
              )}
            </div>
          </div>
        )}

        {/* Integrations */}
        {activeTab === 'integrations' && (
          <div className="bg-white rounded-lg shadow p-8">
            <h2 className="text-2xl font-bold text-gray-900 mb-6">Entegrasyonlar</h2>

            <div className="space-y-6">
              <div className="border border-gray-200 rounded-lg p-6">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">📱 Netgsm SMS</h3>
                    <p className="text-gray-600 text-sm mt-1">SMS hatırlatıcıları ve bildirimler</p>
                  </div>
                  <span className="px-3 py-1 bg-yellow-100 text-yellow-800 rounded text-xs font-semibold">
                    Demo
                  </span>
                </div>
                <div className="mt-4 space-y-3">
                  <input
                    type="text"
                    placeholder="API Key"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm"
                  />
                  <input
                    type="password"
                    placeholder="API Secret"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm"
                  />
                  <button className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">
                    Bağlantıyı Test Et
                  </button>
                </div>
              </div>

              <div className="border border-gray-200 rounded-lg p-6">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">💳 Iyzico Ödeme</h3>
                    <p className="text-gray-600 text-sm mt-1">Kredi kartı ve banka ödemeleri</p>
                  </div>
                  <span className="px-3 py-1 bg-yellow-100 text-yellow-800 rounded text-xs font-semibold">
                    Demo
                  </span>
                </div>
                <div className="mt-4 space-y-3">
                  <input
                    type="text"
                    placeholder="API Key"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm"
                  />
                  <input
                    type="password"
                    placeholder="Secret Key"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm"
                  />
                  <button className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">
                    Bağlantıyı Test Et
                  </button>
                </div>
              </div>

              <div className="border border-gray-200 rounded-lg p-6">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">📋 e-Arşiv (GIB)</h3>
                    <p className="text-gray-600 text-sm mt-1">Elektronik fatura sistemi</p>
                  </div>
                  <span className="px-3 py-1 bg-yellow-100 text-yellow-800 rounded text-xs font-semibold">
                    Demo
                  </span>
                </div>
                <div className="mt-4 space-y-3">
                  <input
                    type="text"
                    placeholder="e-Arşiv Kullanıcı Adı"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm"
                  />
                  <input
                    type="password"
                    placeholder="e-Arşiv Şifresi"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm"
                  />
                  <button className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">
                    Bağlantıyı Test Et
                  </button>
                </div>
              </div>

              <div className="border border-gray-200 rounded-lg p-6">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">🏥 e-Nabız</h3>
                    <p className="text-gray-600 text-sm mt-1">Sağlık Bakanlığı sistemi</p>
                  </div>
                  <span className="px-3 py-1 bg-yellow-100 text-yellow-800 rounded text-xs font-semibold">
                    Demo
                  </span>
                </div>
                <div className="mt-4">
                  <p className="text-gray-700 text-sm">
                    e-Nabız entegrasyonu Sağlık Bakanlığı tarafından onaylanmıştır.
                  </p>
                  <button className="mt-3 px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">
                    Konfigüre Et
                  </button>
                </div>
              </div>
            </div>

            <div className="mt-8">
              <button
                onClick={handleSave}
                className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-semibold transition-all"
              >
                💾 Entegrasyonları Kaydet
              </button>
            </div>
          </div>
        )}

        {/* Notifications */}
        {activeTab === 'notifications' && (
          <div className="bg-white rounded-lg shadow p-8">
            <h2 className="text-2xl font-bold text-gray-900 mb-6">Bildirim Ayarları</h2>

            <div className="space-y-4">
              <div className="flex items-center justify-between p-4 border border-gray-200 rounded-lg">
                <div>
                  <h3 className="font-semibold text-gray-900">📱 SMS Hatırlatıcıları</h3>
                  <p className="text-gray-600 text-sm">Randevu öncesi SMS gönder</p>
                </div>
                <input type="checkbox" defaultChecked className="w-6 h-6" />
              </div>

              <div className="flex items-center justify-between p-4 border border-gray-200 rounded-lg">
                <div>
                  <h3 className="font-semibold text-gray-900">📧 Email Hatırlatıcıları</h3>
                  <p className="text-gray-600 text-sm">Randevu öncesi email gönder</p>
                </div>
                <input type="checkbox" defaultChecked className="w-6 h-6" />
              </div>

              <div className="flex items-center justify-between p-4 border border-gray-200 rounded-lg">
                <div>
                  <h3 className="font-semibold text-gray-900">🔔 Push Bildirimleri</h3>
                  <p className="text-gray-600 text-sm">Mobil uygulama push bildirimleri</p>
                </div>
                <input type="checkbox" defaultChecked className="w-6 h-6" />
              </div>

              <div className="mt-6 bg-blue-50 border border-blue-200 rounded-lg p-4">
                <h3 className="font-semibold text-gray-900 mb-3">Hatırlatıcı Zamanlaması</h3>
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm font-semibold text-gray-900 mb-2">
                      Bildirim Zamanı (Randevudan kaç saat önce)
                    </label>
                    <select className="w-full px-4 py-2 border border-gray-300 rounded-lg">
                      <option>1 saat</option>
                      <option selected>24 saat</option>
                      <option>48 saat</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-8">
              <button
                onClick={handleSave}
                className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-semibold transition-all"
              >
                💾 Bildirim Ayarlarını Kaydet
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
