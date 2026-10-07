# DentOS Database Setup

Supabase direct database connection issue (DNS resolution) nedeniyle manual setup gerekli.

## Çözüm: Supabase SQL Editor Kullanarak

### Adım 1: Supabase Dashboardına Gir
https://supabase.com/dashboard/project/knzrcgqpzjbajfboqlhq

### Adım 2: SQL Editor Aç
Sol sidebar → SQL Editor

### Adım 3: Migrasyonları Sırayla Yürüt

Her migration dosyasını (`packages/db/migrations/`) sırayla kopyala ve Supabase SQL Editor'de çalıştır:

```bash
# Terminal'den migration içeriğini kopyala:
cat packages/db/migrations/0001_init.sql
```

Sonra SQL Editor'de yapıştır ve "RUN" butonuna tıkla.

**Sıra:**
1. 0001_init.sql
2. 0002_procedures_catalog.sql
3. 0003_patients.sql
4. 0004_appointments.sql
5. 0005_notifications.sql
6. 0006_device_tokens.sql
7. 0007_treatment_plans.sql
8. 0008_crm_leads.sql
9. 0009_lab_orders.sql
10. 0010_compliance.sql

### Adım 4: Test Verisi Yükle

```bash
# Terminal'den:
curl -X POST http://localhost:3000/api/seed
```

### Adım 5: Uygulamayı Aç

```
http://localhost:3000/login
```

**Test Credentials:**
- Email: `admin@klinikmerkezi.com.tr`
- Password: (Supabase Auth üzerinden OTP ile gir)

## Alternatif: Docker PostgreSQL

Eğer doğrudan Supabase kullanamıyorsan:

```bash
# Docker container başlat
docker run --name dentos-postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=dentos \
  -p 5432:5432 \
  -d postgres:15

# Migrasyonları uygula
pnpm -F db push
```

## SSH Tunnel (İleri)

Eğer SSH erişiminiz varsa:

```bash
ssh -L 5432:db.knzrcgqpzjbajfboqlhq.supabase.co:5432 user@server
```

Sonra `.env` güncelle:
```
DATABASE_URL=postgresql://postgres:PASSWORD@localhost:5432/postgres
```

## Status

- [x] Schema tanımları hazır (packages/db/schema/)
- [x] Migrasyonlar hazır (packages/db/migrations/)
- [x] API routes hazır (apps/web/src/app/api/)
- [x] UI bileşenler hazır
- [ ] ⚠️ Database tables (manual setup gerekli)
- [ ] Authentication integration
- [ ] Seed data

## Destek

Sorun oluşursa:
1. Supabase dashboard'dan database status'ü kontrol et
2. `nslookup db.knzrcgqpzjbajfboqlhq.supabase.co` çalış
3. https://github.com/anthropics/claude-code/issues raporla
