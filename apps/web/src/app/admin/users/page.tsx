'use client';

import { useState } from 'react';

interface User {
  id: string;
  email: string;
  full_name: string;
  role: 'admin' | 'doctor' | 'receptionist';
  specialization?: string;
  is_active: boolean;
  created_at: string;
}

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([
    {
      id: '22222222-2222-2222-2222-222222222222',
      email: 'admin@klinikmerkezi.com.tr',
      full_name: 'Admin User',
      role: 'admin',
      is_active: true,
      created_at: '2026-09-01',
    },
    {
      id: '33333333-3333-3333-3333-333333333333',
      email: 'dr.ece@klinikmerkezi.com.tr',
      full_name: 'Dr. Ece Kara',
      role: 'doctor',
      specialization: 'Genel Diş Tedavisi',
      is_active: true,
      created_at: '2026-09-05',
    },
    {
      id: '44444444-4444-4444-4444-444444444444',
      email: 'dr.cem@klinikmerkezi.com.tr',
      full_name: 'Dr. Cem Aydemir',
      role: 'doctor',
      specialization: 'Ortodontisi',
      is_active: true,
      created_at: '2026-09-05',
    },
  ]);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    email: '',
    full_name: '',
    role: 'receptionist' as const,
    specialization: '',
  });

  const handleAddUser = () => {
    if (!formData.email || !formData.full_name) {
      alert('Email ve ad zorunludur');
      return;
    }

    if (editingId) {
      setUsers(
        users.map((u) =>
          u.id === editingId
            ? { ...u, ...formData }
            : u
        )
      );
      setEditingId(null);
    } else {
      const newUser: User = {
        id: `${Date.now()}`,
        ...formData,
        is_active: true,
        created_at: new Date().toISOString().split('T')[0],
      };
      setUsers([...users, newUser]);
    }

    setFormData({
      email: '',
      full_name: '',
      role: 'receptionist',
      specialization: '',
    });
    setShowForm(false);
  };

  const handleEdit = (user: User) => {
    setFormData({
      email: user.email,
      full_name: user.full_name,
      role: user.role,
      specialization: user.specialization || '',
    });
    setEditingId(user.id);
    setShowForm(true);
  };

  const handleDelete = (id: string) => {
    if (confirm('Bu kullanıcıyı silmek istediğinizden emin misiniz?')) {
      setUsers(users.filter((u) => u.id !== id));
    }
  };

  const handleCancel = () => {
    setShowForm(false);
    setEditingId(null);
    setFormData({
      email: '',
      full_name: '',
      role: 'receptionist',
      specialization: '',
    });
  };

  const roleLabels = {
    admin: '👨‍💼 Yönetici',
    doctor: '👨‍⚕️ Doktor',
    receptionist: '👩‍💼 Resepsiyon',
  };

  const roleDescriptions = {
    admin: 'Tüm sistemde tam erişim, kullanıcı yönetimi',
    doctor: 'Randevu, hasta, tedavi planları yönetimi',
    receptionist: 'Randevu ve hasta takibi',
  };

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-2">👥 Kullanıcı Yönetimi</h1>
          <p className="text-gray-600">Klinik personelini ve yöneticileri yönet</p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <div className="bg-white rounded-lg shadow p-6">
            <div className="text-3xl font-bold text-blue-600">{users.length}</div>
            <div className="text-sm text-gray-600 mt-2">Toplam Kullanıcı</div>
          </div>
          <div className="bg-white rounded-lg shadow p-6">
            <div className="text-3xl font-bold text-green-600">
              {users.filter((u) => u.role === 'doctor').length}
            </div>
            <div className="text-sm text-gray-600 mt-2">Doktor</div>
          </div>
          <div className="bg-white rounded-lg shadow p-6">
            <div className="text-3xl font-bold text-purple-600">
              {users.filter((u) => u.is_active).length}
            </div>
            <div className="text-sm text-gray-600 mt-2">Aktif Kullanıcı</div>
          </div>
        </div>

        {/* Add User Button */}
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="mb-8 px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-semibold transition-all"
          >
            ➕ Yeni Kullanıcı Ekle
          </button>
        )}

        {/* Add/Edit Form */}
        {showForm && (
          <div className="bg-white rounded-lg shadow-lg p-8 mb-8">
            <h2 className="text-2xl font-bold text-gray-900 mb-6">
              {editingId ? 'Kullanıcıyı Düzenle' : 'Yeni Kullanıcı Oluştur'}
            </h2>

            <div className="space-y-4 mb-6">
              <div>
                <label className="block text-sm font-semibold text-gray-900 mb-2">
                  Email *
                </label>
                <input
                  type="email"
                  value={formData.email}
                  onChange={(e) =>
                    setFormData({ ...formData, email: e.target.value })
                  }
                  placeholder="kullanici@klinikmerkezi.com.tr"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-gray-900 mb-2">
                  Ad Soyad *
                </label>
                <input
                  type="text"
                  value={formData.full_name}
                  onChange={(e) =>
                    setFormData({ ...formData, full_name: e.target.value })
                  }
                  placeholder="Örn: Dr. Ahmet Yılmaz"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-gray-900 mb-2">
                  Rol *
                </label>
                <select
                  value={formData.role}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      role: e.target.value as 'admin' | 'doctor' | 'receptionist',
                    })
                  }
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  <option value="receptionist">👩‍💼 Resepsiyon</option>
                  <option value="doctor">👨‍⚕️ Doktor</option>
                  <option value="admin">👨‍💼 Yönetici</option>
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  {roleDescriptions[formData.role]}
                </p>
              </div>

              {formData.role === 'doctor' && (
                <div>
                  <label className="block text-sm font-semibold text-gray-900 mb-2">
                    Uzmanlık Alanı
                  </label>
                  <input
                    type="text"
                    value={formData.specialization}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        specialization: e.target.value,
                      })
                    }
                    placeholder="Örn: Genel Diş Tedavisi, Ortodontisi"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
              )}
            </div>

            <div className="flex gap-4">
              <button
                onClick={handleAddUser}
                className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 font-semibold transition-all"
              >
                {editingId ? '💾 Kaydet' : '➕ Ekle'}
              </button>
              <button
                onClick={handleCancel}
                className="px-6 py-2 bg-gray-300 text-gray-900 rounded-lg hover:bg-gray-400 font-semibold transition-all"
              >
                ✕ İptal
              </button>
            </div>
          </div>
        )}

        {/* Users Table */}
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-100">
                <tr>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                    Ad
                  </th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                    Email
                  </th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                    Rol
                  </th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                    Uzmanlık
                  </th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                    Durumu
                  </th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                    Oluş. Tarihi
                  </th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                    İşlemler
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {users.map((user) => (
                  <tr key={user.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 text-sm text-gray-900 font-medium">
                      {user.full_name}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-600">
                      {user.email}
                    </td>
                    <td className="px-6 py-4 text-sm">
                      <span className="px-3 py-1 bg-blue-100 text-blue-800 rounded-full text-xs font-semibold">
                        {roleLabels[user.role]}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-600">
                      {user.specialization || '—'}
                    </td>
                    <td className="px-6 py-4 text-sm">
                      <span
                        className={`px-3 py-1 rounded-full text-xs font-semibold ${
                          user.is_active
                            ? 'bg-green-100 text-green-800'
                            : 'bg-red-100 text-red-800'
                        }`}
                      >
                        {user.is_active ? '✓ Aktif' : '✗ Pasif'}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-600">
                      {new Date(user.created_at).toLocaleDateString('tr-TR')}
                    </td>
                    <td className="px-6 py-4 text-sm space-x-2">
                      <button
                        onClick={() => handleEdit(user)}
                        className="px-3 py-1 bg-blue-100 text-blue-700 rounded hover:bg-blue-200 transition-all text-xs font-semibold"
                      >
                        Düzenle
                      </button>
                      <button
                        onClick={() => handleDelete(user.id)}
                        className="px-3 py-1 bg-red-100 text-red-700 rounded hover:bg-red-200 transition-all text-xs font-semibold"
                      >
                        Sil
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Info Box */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-6 mt-8">
          <h3 className="font-semibold text-gray-900 mb-3">ℹ️ Roller Hakkında</h3>
          <div className="space-y-2 text-sm text-gray-700">
            <p>
              <strong>👨‍💼 Yönetici:</strong> Tüm sistem özelliklerine erişim, kullanıcı yönetimi, ayarlar
            </p>
            <p>
              <strong>👨‍⚕️ Doktor:</strong> Randevu, hasta, tedavi planları, treatment plans
            </p>
            <p>
              <strong>👩‍💼 Resepsiyon:</strong> Randevu ve hasta takibi, temel işlemler
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
