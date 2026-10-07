# 🦷 DentOS - Turkish Dental Clinic Management System

Comprehensive Next.js + React Native dental clinic operating system with Turkish healthcare compliance (e-Arşiv, e-Nabız, KVKK).

## 📊 Project Status

### Completed (Sprint 0-8)
- ✅ **S0** - Core infrastructure (Auth, Database schema, API)
- ✅ **S1** - Patient management with KVKK compliance
- ✅ **S2** - Appointment scheduling & conflict detection
- ✅ **S3** - SMS webhooks & Netgsm integration
- ✅ **S4** - AI appointment assistant & push notifications
- ✅ **S5** - Treatment plans & Iyzico payment processing (1/3/6/12 month installments)
- ✅ **S6** - CRM with Kanban board & lead management
- ✅ **S7** - Lab orders & inventory management
- ✅ **S8** - Turkish healthcare compliance (e-Arşiv, e-Nabız, KVKK audit logs)

### Technology Stack

**Frontend**
- Next.js 14 (App Router, TypeScript)
- React 19 with Zustand state management
- Tailwind CSS responsive design
- Expo React Native (patient mobile app)

**Backend**
- Node.js APIs
- Supabase PostgreSQL with Row Level Security
- Drizzle ORM for schema management
- GitHub Actions CI/CD

**Turkish Integration**
- **e-Arşiv**: Electronic invoice generation (UUID tracking)
- **e-Nabız**: National Health System patient records
- **KVKK**: Turkish GDPR compliance logging
- **Netgsm**: SMS gateway (Turkish phone validation)
- **Iyzico**: Payment processing (Turkish bank cards)

## 🚀 Quick Start

### Prerequisites
```bash
- Node.js 18+
- pnpm package manager
- Supabase account (free tier OK)
```

### Installation

```bash
# Clone repository
git clone <repo>
cd dentos

# Install dependencies
pnpm install

# Setup environment variables
cp .env.example .env.local
# Edit .env.local with your Supabase credentials
```

### Run Development Servers

```bash
# Web admin panel (localhost:3000)
pnpm -F web dev

# Mobile app (Expo)
pnpm -F mobile start

# API backend
pnpm -F api dev
```

## 🗄️ Database Setup

### Issue: DNS Resolution (Workaround)

Direct PostgreSQL connection to Supabase database server is blocked by DNS resolution issues. 

**Solution Options:**

#### Option 1: Manual Supabase SQL Editor (Recommended)
1. Go to https://supabase.com/dashboard/project/knzrcgqpzjbajfboqlhq
2. Open "SQL Editor"
3. Copy & paste each migration file in order:
   - `packages/db/migrations/0001_init.sql`
   - `packages/db/migrations/0002_procedures_catalog.sql`
   - ... (all 10 migrations)
4. Run each migration and confirm success

#### Option 2: Local Docker PostgreSQL
```bash
docker run --name dentos-postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=dentos \
  -p 5432:5432 \
  -d postgres:15

# Then apply migrations
pnpm -F db push
```

#### Option 3: Use Demo Mode
App includes demo/mock data for testing without database:
```typescript
// apps/web/src/lib/demo-data.ts
import { demoAppointments, demoPatients, ... } from '@/lib/demo-data';
```

### Seed Test Data

```bash
# After database setup, seed test data
curl -X POST http://localhost:3000/api/seed

# Or manually via UI once database is connected
```

## 📱 Application Features

### Web Admin Dashboard
- 📅 **Appointment Management** - Schedule, reschedule, cancel with 24-hour window
- 👥 **Patient Management** - Full profiles with KVKK consent tracking
- 💰 **Treatment Plans** - Cost estimation with installment options
- 🔔 **Reminders** - SMS/Email/Push notifications (24h before appointment)
- 🎯 **CRM** - 6-column Kanban board (New → Contacted → Interested → Qualified → Customer → Lost)
- 📊 **Reports** - Compliance reports (e-Arşiv, e-Nabız, audit logs)
- 📦 **Inventory** - Stock tracking with low-stock alerts
- 🧪 **Lab Orders** - Dental lab work orders with status tracking

### Mobile Patient App (Expo)
- 📱 **OTP Authentication** - SMS-based login
- 📅 **View Appointments** - Upcoming appointments with doctor info
- 🗓️ **Book Appointments** - Multi-step wizard (doctor → date → time → confirm)
- 💳 **Payment Plans** - Select installment options (1/3/6/12 months)
- 👤 **Profile Management** - Update personal info, view KVKK status
- 🔔 **Push Notifications** - 24-hour appointment reminders

## 🔐 Architecture

### Multi-Tenant with Row Level Security

Every table includes `clinic_id` foreign key with RLS policies:
```sql
CREATE POLICY "clinic_isolation" ON patients FOR SELECT
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);
```

### API Routes
- `POST /api/appointments` - Create/manage appointments
- `POST /api/seed` - Initialize test data
- `GET /api/admin/compliance` - Compliance reports
- `POST /api/webhooks/sms` - Netgsm incoming SMS

### Database Schema (10 Migrations)

| Migration | Tables | Purpose |
|-----------|--------|---------|
| 0001_init.sql | clinics, users, doctors | Core setup |
| 0003_patients.sql | patients, contact_methods | Patient data |
| 0004_appointments.sql | appointments, appointment_notes | Scheduling |
| 0007_treatment_plans.sql | treatment_plans, payments | Costing |
| 0008_crm_leads.sql | leads, lead_activities | Lead tracking |
| 0009_lab_orders.sql | lab_orders, stock_items | Inventory |
| 0010_compliance.sql | audit_logs, einvoices, enabiz_logs | Compliance |

## 🔗 Integration Ready

### Netgsm SMS Gateway
```typescript
const sms = new SMSGateway();
await sms.sendAppointmentReminder(patientPhone, appointmentTime);
```

### Iyzico Payments
```typescript
const payment = new PaymentService();
const installments = payment.calculateInstallments(amount, months);
await payment.processPayment(cardToken, installments);
```

### e-Arşiv Invoices
```typescript
const invoice = await ComplianceService.generateEInvoice({
  invoiceNumber: 'INV-001',
  patientName: 'Ahmet Yılmaz',
  patientTCNo: '12345678901', // Validated
  totalAmount: 5000,
  taxAmount: 1000
});
```

## 📊 Demo Data Available

When database is unavailable, demo mode activates:
- 2 Doctors (Ece Kara, Cem Aydemir)
- 3 Patients (with appointments)
- 2 Treatment plans
- 10 Leads in various stages
- 2 Lab orders
- Inventory items with low-stock alerts

## ⚙️ Configuration

### Environment Variables

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://knzrcgqpzjbajfboqlhq.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGc...
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...
DATABASE_URL=postgresql://postgres:PASSWORD@localhost:5432/postgres

# Integrations (Optional for production)
NETGSM_API_KEY=your_netgsm_key
NETGSM_API_SECRET=your_netgsm_secret
IYZICO_API_KEY=your_iyzico_key
IYZICO_API_SECRET=your_iyzico_secret

# E-Arşiv (Turkish Tax Authority)
EARSIV_USERNAME=your_earsiv_user
EARSIV_PASSWORD=your_earsiv_pass
```

## 🧪 Testing

```bash
# Run tests
pnpm test

# Type checking
pnpm typecheck

# Lint
pnpm lint

# Build for production
pnpm build
```

## 📖 Documentation

### Getting Started
- [Getting Started (10-minute quickstart)](./GETTING_STARTED.md)
- [Setup & Installation](./IMPLEMENTATION_CHECKLIST.md)

### Reference
- [Complete Features Catalog](./FEATURES.md)
- [Quick Reference Card](./QUICK_REFERENCE.md)
- [Database Setup Options](./DATABASE_SETUP.md)
- [Production Deployment](./DEPLOYMENT.md)

### Development
- [API Documentation](./apps/api/README.md)
- [Mobile App Guide](./apps/mobile/README.md)

### Interactive Pages
- **[/setup](http://localhost:3000/setup)** - Setup wizard (Demo/Docker/Supabase)
- **[/features](http://localhost:3000/features)** - Interactive features showcase

## 🐛 Known Issues

1. **Database DNS Resolution** - Supabase database server DNS not resolving from Node.js
   - **Workaround**: Use Supabase SQL Editor (web) or Docker PostgreSQL
   - **Status**: Investigating

2. **CI/CD GitHub Actions** - Requires GitHub PAT with workflow permissions
   - **Fix**: Generate new token at https://github.com/settings/tokens
   - **Status**: Documented

## 🚀 Deployment

### Docker
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY . .
RUN pnpm install
RUN pnpm build
EXPOSE 3000
CMD ["pnpm", "start"]
```

### Vercel
```bash
# Web app deploys automatically
vercel deploy

# Environment variables via dashboard
```

### Docker Compose (Full Stack)
```bash
docker-compose up -d
# Services: Next.js, Mobile Expo, PostgreSQL, Supabase
```

## 📋 Roadmap

### Phase 2 (Potential)
- [ ] Video consultation integration
- [ ] Advanced analytics dashboard
- [ ] Blockchain-based prescriptions
- [ ] AI-powered treatment recommendations
- [ ] Multi-language support (TR, EN, AR, DE)
- [ ] IoT sensor integration (patient monitoring)

## 🤝 Contributing

DentOS is developed as a complete Turkish dental clinic system. Contributions welcome for:
- Turkish healthcare compliance improvements
- Performance optimization
- Additional integrations
- UI/UX enhancements

## 📞 Support

For issues and questions:
- GitHub Issues: [Project Issues](https://github.com/anthropics/claude-code/issues)
- Documentation: See `/docs` directory
- Supabase Docs: https://supabase.com/docs

## 📄 License

© 2026 Klinik Prime Maltepe - All Rights Reserved

---

**Built with ❤️ using Claude Code** 🤖
