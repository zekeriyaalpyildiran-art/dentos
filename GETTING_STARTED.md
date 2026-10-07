# 🎯 DentOS - Getting Started Guide

Get the Diş Kliniği Management System running in 10 minutes.

## ⚡ Super Quick Start (10 min)

### Prerequisites
- Node.js 18+
- pnpm (`npm install -g pnpm`)
- Git

### 1️⃣ Clone & Install

```bash
git clone https://github.com/zekeriyaalpyildiran-art/dentos.git
cd dentos
pnpm install
```

### 2️⃣ Start Web App

```bash
# Terminal 1: Start dev server
pnpm -F web dev

# Opens at http://localhost:3000
```

### 3️⃣ Visit Setup Page

Open browser to: **http://localhost:3000/setup**

This interactive wizard guides you through:
1. Creating database tables (Supabase or Docker)
2. Seeding test data
3. Testing authentication
4. Exploring dashboard

That's it! ✅

---

## 📖 Detailed Setup (Choose Your Database)

### Option A: Docker (Easiest - Local Only)

**Recommended for learning & development**

```bash
# 1. Start database
docker-compose up -d

# 2. Run migrations (automatic on container start)
# Already included in docker-compose.yml

# 3. Start web app
pnpm -F web dev

# 4. Seed test data
curl -X POST http://localhost:3000/api/seed
```

**That's all!** Database ready, test data loaded.

### Option B: Supabase Cloud

**Best for production or collaborative development**

```bash
# 1. Get Supabase credentials
# - Go to https://supabase.com/dashboard
# - Create new project (or use existing)
# - Get URL and Anon Key from Settings → API

# 2. Update .env.local
cat > apps/web/.env.local << EOF
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...your_key...
EOF

# 3. Go to http://localhost:3000/setup
# - Follow Step 1: Copy each migration to Supabase SQL Editor
# - Copy each SQL file from packages/db/migrations/
# - Paste into Supabase SQL Editor and click RUN

# 4. Seed data: curl -X POST http://localhost:3000/api/seed
```

**Create tables in Supabase:**
1. Go to: https://supabase.com/dashboard/project/knzrcgqpzjbajfboqlhq
2. Click "SQL Editor" (left sidebar)
3. For each file in `packages/db/migrations/`:
   - Open the file in your editor
   - Copy entire contents
   - Paste into Supabase SQL Editor
   - Click "RUN" button
   - Wait for success message
4. Done!

---

## 🎮 Using the App

### Access Points

| URL | Purpose | Status |
|-----|---------|--------|
| http://localhost:3000 | Home (redirects to login) | ✅ |
| http://localhost:3000/login | Login page | ✅ |
| http://localhost:3000/setup | Setup wizard | ✅ |
| http://localhost:3000/dashboard | Admin dashboard | ✅ |
| http://localhost:3000/api/seed | Load test data | ✅ |

### Demo User (After Setup)

When you seed data, these users are created:

**Admin**
- Email: `admin@klinikmerkezi.com.tr`
- Login: Use email + OTP (check database)

**Doctors**
- Dr. Ece Kara (Genel Diş Tedavisi)
- Dr. Cem Aydemir (Ortodontisi)

**Patients** (Already in system)
- Ahmet Yılmaz
- Mehmet Şahin
- Selin Özkan

### Features to Explore

**Dashboard** (`/dashboard`)
- View clinic statistics
- See upcoming appointments
- Quick access to all modules

**Appointments** (`/appointments`)
- View all appointments
- Create new appointments
- Reschedule/cancel (24-hour window)
- SMS/Email reminders auto-sent

**Patients** (`/patients`)
- Patient profiles
- Medical history
- KVKK consent tracking
- Treatment history

**Treatment Plans** (`/treatment-plans`)
- Create treatment plans
- Set pricing & procedures
- Track payment status
- 1/3/6/12 month installments

**CRM** (`/crm/kanban`)
- Kanban board with 6 columns:
  - 🆕 Yeni (New)
  - ☎️ İletişime Geçildi (Contacted)
  - ⭐ İlgilendiği (Interested)
  - ✅ Nitelikli (Qualified)
  - 🎯 Müşteri (Customer)
  - ❌ Kaybedildi (Lost)
- Drag-drop leads to update status

**Inventory** (`/inventory`)
- Track materials & supplies
- Low-stock alerts
- Expiry date monitoring
- Purchase history

**Lab Orders** (`/lab`)
- Submit dental work to labs
- Track order status
- Tooth numbers & materials
- Delivery tracking

**Reports** (`/reports`)
- e-Arşiv (e-Invoice) status
- e-Nabız (Health System) records
- KVKK audit logs
- Compliance reports

---

## 🧪 Testing Features

### Without Real Integrations

The app works fully with **demo/mock data** without:
- Actual Netgsm SMS (logs SMS text locally)
- Actual Iyzico payments (mock transaction IDs)
- Actual e-Arşiv/e-Nabız (test IDs generated)

Perfect for testing UI and logic!

### With Real Integrations (Production)

Add these to `.env.local`:

```env
# SMS Gateway
NETGSM_API_KEY=your_key_from_netgsm
NETGSM_API_SECRET=your_secret

# Payment Processing
IYZICO_API_KEY=your_key_from_iyzico
IYZICO_SECRET_KEY=your_secret

# E-Arşiv (Turkish Tax Authority)
EARSIV_USERNAME=your_tax_id
EARSIV_PASSWORD=your_password
```

---

## 📱 Mobile App (Expo)

Run patient app on phone/emulator:

```bash
# Terminal 2: Start Expo
pnpm -F mobile start

# Scan QR code with Expo Go app
# Or press 'i' for iOS Simulator, 'a' for Android Emulator
```

### Mobile Features
- 📱 OTP phone login
- 📅 View appointments
- 🗓️ Book new appointments
- 👤 Manage profile
- 🔔 Push notifications

---

## 🔧 Troubleshooting

### "Cannot connect to database"
```bash
# If using Supabase:
# 1. Verify NEXT_PUBLIC_SUPABASE_URL is set
# 2. Check URL starts with https://
# 3. Verify tables exist in Supabase (SQL Editor)

# If using Docker:
# 1. Is Docker running?
# 2. Did migrations run?
#    docker-compose logs postgres

# 3. Manually apply a migration:
#    docker-compose exec postgres \
#      psql -U postgres -d dentos \
#      -f /docker-entrypoint-initdb.d/0001_init.sql
```

### "Seed data didn't load"
```bash
# Check migrations exist first
curl http://localhost:3000/test-connection

# Then try seed again
curl -X POST http://localhost:3000/api/seed

# See logs
docker-compose logs postgres | grep -i error
```

### "Port 3000 already in use"
```bash
# Find process using port
lsof -i :3000

# Kill it
kill -9 <PID>

# Or use different port
pnpm -F web dev -- -p 3001
```

### "pnpm install fails"
```bash
# Clear cache and try again
rm -rf node_modules pnpm-lock.yaml
pnpm install

# Or update pnpm
npm install -g pnpm@latest
```

---

## 📚 Documentation Files

| File | Purpose |
|------|---------|
| [README.md](./README.md) | Project overview, architecture, all sprints |
| [DATABASE_SETUP.md](./DATABASE_SETUP.md) | Database connection issues & workarounds |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Production deployment guide |
| [GETTING_STARTED.md](./GETTING_STARTED.md) | This file - quick start guide |

---

## 🎓 Learning Path

1. **Start here:** This file (GETTING_STARTED.md)
2. **Setup:** Run through http://localhost:3000/setup
3. **Explore:** Test features in dashboard
4. **Read:** [README.md](./README.md) for technical details
5. **Deploy:** [DEPLOYMENT.md](./DEPLOYMENT.md) for production

---

## ❓ Common Questions

### Q: Can I use this without a database?
**A:** Yes! Demo mode has test data built-in. Go to `/dashboard` without setup.

### Q: How do I add more test data?
**A:** Edit `apps/web/src/lib/demo-data.ts` or use `curl -X POST /api/seed`

### Q: Where are the real migrations?
**A:** `packages/db/migrations/` - 10 SQL files covering all tables

### Q: Can I deploy this to production?
**A:** Yes! See [DEPLOYMENT.md](./DEPLOYMENT.md) for Vercel, AWS, Docker guides

### Q: Is this open source?
**A:** Yes, repository: https://github.com/zekeriyaalpyildiran-art/dentos

### Q: Do I need Supabase?
**A:** No, use Docker PostgreSQL instead. Supabase optional for production.

---

## 🎉 Next Steps

After setup, you can:

- ✅ Explore all features with test data
- ✅ Customize for your clinic
- ✅ Add real Netgsm/Iyzico integration
- ✅ Deploy to production
- ✅ Invite users (staffadmin, doctors, reception)

---

## 🆘 Need Help?

- **Issues:** https://github.com/zekeriyaalpyildiran-art/dentos/issues
- **Setup Page:** http://localhost:3000/setup
- **Test Connection:** http://localhost:3000/test-connection
- **Documentation:** Read README.md, DATABASE_SETUP.md, DEPLOYMENT.md

---

**Welcome to DentOS! 🦷**

Built with ❤️ for Turkish dental clinics.
