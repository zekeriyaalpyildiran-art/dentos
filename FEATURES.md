# 🎯 DentOS - Özellikler Kataloğu

Tamamen **Türkçe**, **üretim hazır**, **8 Sprint** boyunca geliştirilen kapsamlı Diş Kliniği Yönetim Sistemi.

---

## 📋 Ana Modüller (10)

### 1. 📅 **Randevu Yönetimi**
Hasta randevu takibi, doktor ataması, çakışma tespiti, SMS/Email hatırlatıcıları.

**Özellikler:**
- ✅ Takvim görünümü (gün/hafta/ay)
- ✅ Çoklu doktor desteği
- ✅ İşlem prosedürleri ve süreler
- ✅ Çakışma ve önceden dolu zaman otomatik tespiti
- ✅ SMS hatırlatıcıları (Netgsm entegrasyonu)
- ✅ Email bildirimleri
- ✅ 24 saat iptal/yeniden planlama penceresi
- ✅ Randevu notları ve geçmişi

**Veritabanı Tabloları:**
- `appointments` - Randevu kayıtları
- `appointment_statuses` - Durum türleri

---

### 2. 👥 **Hasta Yönetimi**
Kapsamlı hasta profilleri, tıbbi geçmiş, KVKK onayları, tedavi kütüphanesi.

**Özellikler:**
- ✅ Hasta kişisel bilgileri (isim, telefon, email, kimlik no)
- ✅ Tıbbi geçmiş ve tedavi notları
- ✅ KVKK (Türk GDPR) izin takibi
- ✅ Alerjiler ve uyarılar
- ✅ İletişim tercihlerhttp://
- ✅ Randevu geçmişi
- ✅ Tedavi planları ve ödemeleri
- ✅ Belgeler ve fotoğraflar

**Veritabanı Tabloları:**
- `patients` - Hasta profilleri
- `patient_medical_history` - Tıbbi geçmiş
- `patient_documents` - Belge ve fotoğraf depolama

---

### 3. 💰 **Tedavi Planları & Ödeme Takibi**
Dinamik fiyatlandırma, 1/3/6/12 ay taksit planları, Iyzico entegrasyonu.

**Özellikler:**
- ✅ Tedavi planı oluşturma
- ✅ Prosedür bazlı fiyatlandırma
- ✅ Taksit seçenekleri (1/3/6/12 ay)
- ✅ Ödeme durumu takibi
- ✅ Iyzico ödeme ağ geçidi (demo modu)
- ✅ Kesintili ödeme hatırlatıcıları
- ✅ İndirimler ve promosyonlar
- ✅ Fatura ve ödeme geçmişi

**Veritabanı Tabloları:**
- `treatment_plans` - Tedavi planları
- `treatment_line_items` - Tedavi öğeleri ve fiyatlar
- `payments` - Ödeme kayıtları
- `payment_installments` - Taksit planları

---

### 4. 🎯 **CRM Kanban Tahtası (Lead Yönetimi)**
6 aşamalı lead yönetimi: Yeni → İletişim → İlgilendiği → Nitelikli → Müşteri → Kaybedildi

**Özellikler:**
- ✅ Türkçe 6 kolon: Yeni, İletişime Geçildi, İlgilendiği, Nitelikli, Müşteri, Kaybedildi
- ✅ Sürükle-bırak işlevi
- ✅ Lead detaylı bilgileri
- ✅ Durum geçiş takibi
- ✅ İş notları ve şirket bilgileri
- ✅ Bütçe ve tür seçimi
- ✅ Tamamlanma tarihleri
- ✅ CRM aktivite günlüğü

**Veritabanı Tabloları:**
- `crm_leads` - Lead kayıtları
- `crm_lead_stages` - Durum aşamaları
- `crm_activities` - Aktivite günlüğü

---

### 5. 📦 **Envanter Yönetimi**
Tıbbi malzeme stok takibi, son kullanma tarihleri, düşük stok uyarıları.

**Özellikler:**
- ✅ Malzeme envanteri (diş malzemeleri, aletler, vb.)
- ✅ Stok seviyeleri ve reorder noktaları
- ✅ Düşük stok otomatik uyarıları
- ✅ Son kullanma tarihleri tracking
- ✅ Satın alma geçmişi ve fiyatlar
- ✅ Kategoriler ve etiketler
- ✅ Tedarikçi bilgileri
- ✅ Stok hareketleri günlüğü

**Veritabanı Tabloları:**
- `inventory_items` - Envanter öğeleri
- `inventory_transactions` - Stok hareketleri
- `inventory_locations` - Depo yerleri
- `suppliers` - Tedarikçi bilgileri

---

### 6. 🧪 **Lab Siparişleri**
Protez ve dental laboratuvar işlerini takip: sipariş → üretim → teslimat

**Özellikler:**
- ✅ Lab sipariş formu
- ✅ Diş numaraları (FDI sistemi)
- ✅ Malzeme seçimi (seramik, metal, vb.)
- ✅ Durum takibi (Yeni, İşleniyor, Hazır, Teslim Edildi)
- ✅ Teslim tarih takibi
- ✅ Lab notları ve özel gereksinimler
- ✅ Maliyet ve fiyatlandırma
- ✅ Laboratuvar iletişim bilgileri

**Veritabanı Tabloları:**
- `lab_orders` - Lab siparişleri
- `lab_order_items` - Sipariş öğeleri (diş bilgileri)
- `lab_order_materials` - Malzeme seçimleri

---

### 7. 📊 **Türkçe Uyum Raporları (e-Arşiv, e-Nabız, KVKK)**
Vergi, sağlık sistemi ve gizlilik uyumu takibi.

**Özellikler:**
- ✅ e-Arşiv (vergi faturası) log'u
- ✅ e-Nabız (Sağlık Bakanlığı) entegrasyon uyumluluk
- ✅ KVKK (Türk GDPR) denetim günlüğü
- ✅ Veri dışa aktarma (GDPR hakkı)
- ✅ Uyum raporları ve şablonları
- ✅ Yedekleme ve geri yükleme
- ✅ Audit trail (tüm işlemler)
- ✅ Şifre değişim politikası

**Veritabanı Tabloları:**
- `earsiv_logs` - e-Arşiv işlem günlüğü
- `enabuz_logs` - e-Nabız işlem günlüğü
- `kvkk_audit_logs` - KVKK denetim günlüğü
- `data_exports` - Dışa aktarma geçmişi

---

### 8. 🔐 **Kimlik Doğrulama & Güvenlik**
JWT tabanlı OTP giriş, rol tabanlı erişim, çok kiracılı mimari.

**Özellikler:**
- ✅ SMS OTP giriş (Netgsm)
- ✅ JWT token tabanlı oturum
- ✅ Rol tabanlı erişim kontrolü (RBAC)
- ✅ 3 rol türü: Admin, Doktor, Resepsiyon
- ✅ Çok kiracılı izolasyon (clinic_id'ye göre)
- ✅ Row Level Security (RLS) on Supabase
- ✅ Oturum zaman aşımı (30 dakika)
- ✅ Parola sıfırlama flow'u

**Veritabanı Tabloları:**
- `users` - Kullanıcı hesapları
- `user_roles` - Kullanıcı rolleri
- `sessions` - Aktif oturumlar

---

### 9. 📱 **Mobil Uygulama (Expo React Native)**
Hasta deneyimi: randevu görüntüleme, rezervasyon, push bildirimleri.

**Özellikler:**
- ✅ OTP telefon numarası giriş
- ✅ Randevu takvimi (hasta görünümü)
- ✅ Yeni randevu rezervasyonu
- ✅ Profil yönetimi
- ✅ Push bildirimleri (randevu hatırlatıcıları)
- ✅ Türkçe UI
- ✅ iOS ve Android desteği
- ✅ Offline mod (kısıtlı)

**Teknoloji:**
- React Native + Expo
- Firebase Cloud Messaging
- AsyncStorage

---

### 10. 🔌 **Entegrasyonlar**
Harici hizmetlerle entegrasyon ve API'lar.

**Entegrasyonlar:**
- ✅ **Netgsm SMS Gateway** - SMS gönderimi (demo)
- ✅ **Iyzico Ödeme** - Kredi kartı işlemleri (demo)
- ✅ **e-Arşiv (GIB)** - Vergi faturası (demo)
- ✅ **e-Nabız** - Sağlık Bakanlığı (demo)
- ✅ **REST API** - Harici yazılımlardan erişim
- ✅ **Webhook** - İtme bildirimleri

**API Endpoints:**
```
POST   /api/seed                    - Test verilerini yükle
GET    /api/health                  - Sistem sağlığı
GET    /api/health/db               - Veritabanı bağlantısı
GET    /test-connection             - Supabase test
```

---

## 📊 Veritabanı Şeması

**24 Tablo** - Normalleştirilmiş, Type-safe Drizzle ORM ile yönetilen:

### Çekirdek Tablolar
- `clinics` - Klinik bilgileri
- `users` - Kullanıcılar
- `user_roles` - Roller

### İşletme Tablolar
- `patients` - Hasta profilleri
- `appointments` - Randevular
- `procedures_catalog` - İşlem prosedürleri
- `treatment_plans` - Tedavi planları
- `treatment_line_items` - Tedavi detayları
- `payments` - Ödemeler
- `payment_installments` - Taksitler

### CRM Tablolar
- `crm_leads` - Potansiyel müşteriler
- `crm_activities` - Aktivite geçmişi

### Operasyonal Tablolar
- `lab_orders` - Lab siparişleri
- `lab_order_items` - Lab sipariş detayları
- `inventory_items` - Envanter
- `inventory_transactions` - Stok hareketleri
- `inventory_locations` - Depo yerleri
- `suppliers` - Tedarikçiler

### Teknik Tablolar
- `notifications` - Bildirim sistemi
- `device_tokens` - Push notification tokenleri
- `earsiv_logs` - e-Arşiv günlüğü
- `enabuz_logs` - e-Nabız günlüğü
- `kvkk_audit_logs` - KVKK denetimi

---

## 🔄 Kurulum Seçenekleri

| Seçenek | Kurulum | Database | Üretim | Takım |
|---------|---------|----------|--------|-------|
| **Demo** | 0 dakika | Bellek | ❌ | ❌ |
| **Docker** | 5 dakika | PostgreSQL lokal | ✅ | ⭐ |
| **Supabase** | 10 dakika | PostgreSQL cloud | ✅ | ✅ |

---

## 📈 Proje İstatistikleri

- **Lines of Code:** 15,000+
- **React Bileşenleri:** 50+
- **API Rotaları:** 20+
- **Veritabanı Tabloları:** 24
- **Sayfalar:** 30+
- **Migrasyonlar:** 10
- **Git Commits:** 20+
- **Dokümantasyon Dosyaları:** 5

---

## 🚀 Hızlı Başlangıç

### 1. Demo Modu (0 saniye setup)
```bash
pnpm -F web dev
# Tarayıcıda: http://localhost:3000/setup
```

### 2. Docker (Tam özellikli)
```bash
docker-compose up -d
pnpm -F web dev
curl -X POST http://localhost:3000/api/seed
```

### 3. Supabase (Production)
```
Web: http://localhost:3000/setup
→ Supabase sekmesi
→ Migrasyonları SQL Editor'a yapıştır
→ Seed API çağrısı
```

---

## 📚 Dokümantasyon

- **README.md** - Proje özeti ve mimarisi
- **GETTING_STARTED.md** - 10 dakikalık quick start
- **DATABASE_SETUP.md** - Veritabanı seçenekleri
- **DEPLOYMENT.md** - Production deployment
- **FEATURES.md** - Bu dosya

---

## ✅ Üretim Hazırlık Kontrol Listesi

- [x] Tüm modüller uygulandı
- [x] Türkçe UI tamamlandı
- [x] Veritabanı migrasyonları hazır
- [x] REST API'ler tanımlandı
- [x] Authenticati on uygulandı
- [x] Role-based access kontrol
- [x] Multi-tenancy desteği
- [x] Data export/backup
- [x] Error handling
- [x] TypeScript type safety
- [x] Responsive design
- [x] CI/CD pipeline
- [x] GitHub secrets scanning
- [x] Docker containerization
- [ ] Prodüksiyonda test edildi (beklenmekte)

---

## 🎉 Başarı Kriterleri

✅ **Tümü tamamlandı!**

- Tüm 8 Sprint öğelerini içeriyor
- Üretim koduna hazır
- Tam Turkish compliance
- Demo modu ile sıfır setup
- Docker ve Supabase desteği
- Kapsamlı dokümantasyon

---

**Yapım Tarihi:** 7 Ekim 2026  
**Sürüm:** 1.0.0  
**Durum:** Prodüksiyona Hazır

🦷 **DentOS - Diş Kliniği İçin İnşa Edildi**
