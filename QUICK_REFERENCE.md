# ⚡ DentOS - Hızlı Referans Kartı

Sık kullanılan komutlar, URL'ler ve işlemler.

---

## 🚀 Kurulum Komutları

### Demo Modu (Sıfır Setup)
```bash
cd /Users/zekalpyil/dentos
pnpm -F web dev
# Tarayıcı: http://localhost:3000
```

### Docker PostgreSQL
```bash
docker-compose up -d                    # Başlat
docker-compose logs postgres            # Günlükleri gör
docker-compose exec postgres psql -U postgres -d dentos    # Bağlan
docker-compose down                     # Durdur
docker-compose down -v                  # Sıfırla
```

### Web Sunucusu
```bash
pnpm -F web dev                         # Geliştirme
pnpm -F web build && pnpm -F web start # Prodüksyon
pnpm -F web lint                        # Kodu kontrol et
```

### Mobil Uygulama
```bash
pnpm -F mobile start                    # Expo başlat
# QR kodu scan et veya 'i' (iOS) / 'a' (Android) tuşuna bas
```

---

## 🔗 Ana URL'ler

| Sayfa | URL | Açıklama |
|-------|-----|----------|
| Setup | `http://localhost:3000/setup` | Kurulum sihirbazı |
| Dashboard | `http://localhost:3000/dashboard` | Ana panel |
| Login | `http://localhost:3000/login` | Giriş sayfası |
| Features | `http://localhost:3000/features` | Özellikleri gör |
| Appointments | `http://localhost:3000/appointments` | Randevular |
| Patients | `http://localhost:3000/patients` | Hastalar |
| Treatment Plans | `http://localhost:3000/treatment-plans` | Tedavi planları |
| CRM Kanban | `http://localhost:3000/crm/kanban` | Lead tahtası |
| Inventory | `http://localhost:3000/inventory` | Envanter |
| Lab Orders | `http://localhost:3000/lab` | Lab siparişleri |
| Reports | `http://localhost:3000/reports` | Raporlar |

---

## 📡 API Endpoints

### Seed & Initialization
```bash
curl -X POST http://localhost:3000/api/seed          # Test verilerini yükle
curl http://localhost:3000/api/health                # Sağlık kontrolü
curl http://localhost:3000/api/health/db             # DB bağlantısı
curl http://localhost:3000/test-connection           # Supabase test
```

---

## 👤 Test Kullanıcıları (Demo Verisi)

### Admin
- **Email:** `admin@klinikmerkezi.com.tr`
- **Rol:** Admin (tüm erişim)
- **Giriş:** Email + OTP (SMS veya console)

### Doktor 1
- **Email:** `dr.ece@klinikmerkezi.com.tr`
- **Ad:** Dr. Ece Kara
- **Uzmanlık:** Genel Diş Tedavisi

### Doktor 2
- **Email:** `dr.cem@klinikmerkezi.com.tr`
- **Ad:** Dr. Cem Aydemir
- **Uzmanlık:** Ortodontisi

### Test Hastalar
- Ahmet Yılmaz (+90 555 123-4567)
- Mehmet Şahin (+90 555 234-5678)
- Selin Özkan (+90 555 345-6789)

---

## 🗄️ Veritabanı İşlemleri

### Supabase Bağlantı
```
URL: https://supabase.com/dashboard
Project: knzrcgqpzjbajfboqlhq
```

### PostgreSQL Bağlantı (Docker)
```bash
# Docker container'a bağlan
docker-compose exec postgres psql -U postgres -d dentos

# Tabloları listele
\dt

# Verileri sor
SELECT * FROM users;
SELECT * FROM appointments;
SELECT * FROM patients;
```

### Migrations Uygulamak
```bash
# Supabase SQL Editor'da
1. https://supabase.com/dashboard adresine git
2. "SQL Editor" seçeneğini aç
3. packages/db/migrations/ dosyalarını sırayla yapıştır
4. Başlangıç sırası: 0001 → 0002 → ... → 0010
```

---

## 🔧 Ortam Değişkenleri (.env.local)

### Supabase
```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGc...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...
```

### Integrations (Opsiyonel)
```env
NETGSM_API_KEY=your_key
NETGSM_API_SECRET=your_secret

IYZICO_API_KEY=your_key
IYZICO_SECRET_KEY=your_secret

EARSIV_USERNAME=your_username
EARSIV_PASSWORD=your_password
```

---

## 📁 Proje Yapısı

```
dentos/
├── apps/
│   ├── web/                 # Next.js admin dashboard
│   │   ├── src/app/         # Sayfalar
│   │   ├── src/components/  # React bileşenleri
│   │   └── src/lib/         # Utility fonksiyonları
│   └── mobile/              # Expo React Native
│       └── src/
├── packages/
│   └── db/                  # Drizzle ORM & migrations
│       └── migrations/      # SQL dosyaları (10)
├── docker-compose.yml       # PostgreSQL + Redis
└── docs/
    ├── README.md
    ├── GETTING_STARTED.md
    ├── FEATURES.md
    ├── DATABASE_SETUP.md
    ├── DEPLOYMENT.md
    └── QUICK_REFERENCE.md   # Bu dosya
```

---

## 🔍 Yaygın Sorunlar & Çözümler

### "Port 3000 zaten kullanılıyor"
```bash
# Farklı port kullan
pnpm -F web dev -- -p 3001

# Veya proces'i öldür
lsof -i :3000
kill -9 <PID>
```

### "Database bağlantısı başarısız"
```bash
# Docker çalışıyor mu?
docker ps

# .env.local dosyası var mı?
ls apps/web/.env.local

# Supabase erişilebilir mi?
curl https://knzrcgqpzjbajfboqlhq.supabase.co
```

### "Migrations uygulanmadı"
```bash
# Supabase SQL Editor'da çalıştır:
SELECT * FROM _drizzle_migrations;

# Tablolar var mı?
\dt
```

### "pnpm install başarısız"
```bash
rm -rf node_modules pnpm-lock.yaml
pnpm install
# veya
npm install -g pnpm@latest
pnpm install
```

---

## 📊 Veritabanı Sorguları

### Aktif Randevuları Gör
```sql
SELECT a.id, a.appointment_date, a.start_time, 
       p.full_name, u.full_name as doctor
FROM appointments a
JOIN patients p ON a.patient_id = p.id
JOIN users u ON a.doctor_id = u.id
WHERE a.status = 'scheduled'
ORDER BY a.appointment_date;
```

### Beklemede Olan Ödemeleri Gör
```sql
SELECT tp.id, tp.total_amount, tp.status,
       p.full_name, COUNT(pi.id) as installments
FROM treatment_plans tp
JOIN patients p ON tp.patient_id = p.id
LEFT JOIN payment_installments pi ON tp.id = pi.treatment_plan_id
WHERE tp.status != 'completed'
GROUP BY tp.id, p.id;
```

### CRM Lead Durumu
```sql
SELECT 
  CASE 
    WHEN stage_id = 1 THEN 'Yeni'
    WHEN stage_id = 2 THEN 'İletişime Geçildi'
    WHEN stage_id = 3 THEN 'İlgilendiği'
    WHEN stage_id = 4 THEN 'Nitelikli'
    WHEN stage_id = 5 THEN 'Müşteri'
    WHEN stage_id = 6 THEN 'Kaybedildi'
  END as durum,
  COUNT(*) as toplam
FROM crm_leads
GROUP BY stage_id;
```

### Düşük Stok Uyarıları
```sql
SELECT id, name, quantity, reorder_level
FROM inventory_items
WHERE quantity <= reorder_level
ORDER BY quantity ASC;
```

---

## 🚀 Deployment Komutları

### Docker Image Oluştur
```bash
docker build -t dentos-web:latest .
docker run -p 3000:3000 \
  -e NEXT_PUBLIC_SUPABASE_URL=... \
  -e NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
  dentos-web:latest
```

### Vercel Deploy
```bash
vercel link
vercel deploy --prod
```

### AWS ECS
```bash
aws ecr get-login-password | docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-1.amazonaws.com
docker tag dentos-web:latest <account>.dkr.ecr.us-east-1.amazonaws.com/dentos-web:latest
docker push <account>.dkr.ecr.us-east-1.amazonaws.com/dentos-web:latest
```

---

## 📚 Dokümantasyon Haritası

- **README.md** → Proje özeti
- **GETTING_STARTED.md** → 10 dakika setup
- **FEATURES.md** → Tüm özellikler
- **DATABASE_SETUP.md** → DB seçenekleri
- **DEPLOYMENT.md** → Production
- **QUICK_REFERENCE.md** → Bu dosya (hızlı komutlar)

---

## 💡 İpuçları

1. **Demo modu kullan** - Veritabanı olmadan özelliği görebilirsin
2. **Docker en kolay** - Bir komut, her şey çalışır
3. **Supabase bulut** - Ekip çalışması için ideal
4. **Feature sayfasını ziyaret et** - Tüm yetenekleri görmek için
5. **GitHub issues** - Sorun olursa açabilirsin

---

**Son Güncelleme:** 7 Ekim 2026  
**Versiyon:** 1.0.0
