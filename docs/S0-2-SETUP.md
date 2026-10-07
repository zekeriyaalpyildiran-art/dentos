# S0.2 — Supabase + Drizzle + RLS Setup

## Status: ✅ In Progress

### Completed
- [x] Drizzle ORM konfigürasyonu (drizzle.config.ts)
- [x] Core schema tanımlama (clinics, users, doctors, chairs)
- [x] Migration SQL (0001_init.sql)
- [x] RLS politikalarını yazma (core.sql)
- [x] Seed veri (2 clinic, users, doctors, chairs)
- [x] RLS test senaryoları (test.sql)
- [x] Custom JWT hook dokümentasyonu

### Remaining: Database setup (manual Supabase dashboard işlemi)

---

## Setup Adımları

### 1️⃣ Supabase Cloud Database Connection String'ini Al

1. https://supabase.com/dashboard/project/knzrcgqpzjbajfboqlhq git
2. **Settings → Database → Connection Pooling** (ya da **Connection string**)
3. **PostgreSQL** tab'ında URI'yi kopyala (şu format):
   ```
   postgresql://postgres:[password]@db.[project-ref].supabase.co:5432/postgres
   ```
4. `.env.local`'da güncelle (packages/db ve root):
   ```env
   DATABASE_URL=postgresql://postgres:[password]@db.knzrcgqpzjbajfboqlhq.supabase.co:5432/postgres
   ```

### 2️⃣ Migration SQL'i Supabase'de Çalıştır

1. Supabase Dashboard → **SQL Editor** tab'ına git
2. **New Query** tıkla
3. Aşağıdaki dosyanın içeriğini yapıştır:
   - `packages/db/migrations/0001_init.sql`
4. **Run** (Ctrl+Enter)
5. Başarılı olursa: "Created <n> objects" mesajı

### 3️⃣ RLS Politikalarını Etkinleştir

1. **SQL Editor** → **New Query**
2. `packages/db/src/rls/core.sql` yapıştır
3. **Run**
4. Başarılı

### 4️⃣ Custom JWT Hook Yapılandır (Supabase)

Supabase Settings → Authentication → Providers:

1. **Supabase** sağlayıcısını tıkla
2. **JWT Secret** bölümünde, JWT generation fonksiyonu ekle:

SQL Editor'de yeni query:
```sql
-- Supabase automatically uses this function to add custom claims to JWT
-- No additional setup needed if auth.users.id matches users.auth_user_id
```

> **NOT:** Supabase free tier'da custom JWT hook sınırlı. İlk aşamada `auth.uid()` ve `auth.email()` otomatik eklenecek. `clinic_id` ve `role` manuel olarak uygulamadan ekleyeceğiz (packages/ai'da token validation sırasında).

### 5️⃣ Seed Verisini Yükle

```bash
cd /Users/zekalpyil/dentos
DATABASE_URL="postgresql://..." pnpm -C packages/db run seed
```

### 6️⃣ RLS Test'i Doğrula

SQL Editor'de test query'lerini çalıştır (`packages/db/src/rls/test.sql`):

```sql
SET request.jwt.claims = '{"clinic_id":"[clinic1-id]","role":"owner"}';
SELECT clinic_id, full_name FROM users;
-- Beklenen: Sadece clinic1 kullanıcıları
```

---

## Dosya Listesi

```
packages/db/
├── drizzle.config.ts              (Drizzle configuration)
├── src/
│   ├── schema/
│   │   ├── core.ts                (clinics, users, doctors, chairs)
│   │   └── index.ts
│   ├── rls/
│   │   ├── core.sql               (RLS politikaları)
│   │   ├── jwt-hook.sql           (Custom JWT hook)
│   │   └── test.sql               (Test senaryoları)
│   ├── client.ts                  (Drizzle client)
│   └── index.ts
├── migrations/
│   └── 0001_init.sql              (Initial schema migration)
├── seed.ts                        (Seed data)
└── package.json                   (Drizzle scripts)
```

---

## Kabul Kriterleri

- [x] Drizzle schema'ları tanımlandı
- [x] Migration SQL hazır
- [x] RLS politikaları yazıldı
- [x] Seed veri hazır
- [ ] **Migration Supabase'de çalışmış** (manual)
- [ ] **RLS test geçmiş** (biri diğerini göremez)
- [ ] **Custom JWT hook ayarlanmış** (manual)

---

## Devam Etmek İçin

1. Supabase Cloud database'e migrations + RLS çalıştır
2. Seed veriyi yükle
3. JWT hook test et
4. `pnpm typecheck && pnpm lint` geçer
5. Commit ve S0.3'e geç
