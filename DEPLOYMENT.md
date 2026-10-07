# 🚀 DentOS Deployment Guide

Complete deployment and configuration guide for production and development.

## 🏃 Quick Start (5 Minutes)

### Option 1: Docker Compose (Recommended for Local Dev)

```bash
# Start all services (PostgreSQL + Redis)
docker-compose up -d

# Initialize database (runs migrations automatically)
docker-compose exec postgres psql -U postgres -d dentos < packages/db/migrations/0001_init.sql

# Start web app
pnpm -F web dev

# Seed test data
curl -X POST http://localhost:3000/api/seed
```

**Then visit:**
- Setup Wizard: http://localhost:3000/setup
- Login: http://localhost:3000/login
- Dashboard: http://localhost:3000/dashboard

### Option 2: Supabase Cloud

```bash
# 1. Go to setup page
http://localhost:3000/setup

# 2. Follow 4-step wizard:
#    - Copy/paste 10 migrations to Supabase SQL Editor
#    - Run seed API
#    - Test connection
#    - Login and explore
```

## 🐳 Docker Deployment

### Development Setup

```bash
# Start services in background
docker-compose up -d

# View logs
docker-compose logs -f postgres
docker-compose logs -f redis

# Connect to database
docker-compose exec postgres psql -U postgres -d dentos

# Stop all services
docker-compose down

# Remove volumes (reset database)
docker-compose down -v
```

### Production Dockerfile

```dockerfile
# Dockerfile
FROM node:18-alpine as builder
WORKDIR /app
COPY . .
RUN pnpm install
RUN pnpm build

FROM node:18-alpine
WORKDIR /app
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json

EXPOSE 3000
CMD ["pnpm", "start"]
```

Build and run:
```bash
docker build -t dentos-web:latest .
docker run -p 3000:3000 \
  -e NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co \
  -e NEXT_PUBLIC_SUPABASE_ANON_KEY=your_key \
  -e DATABASE_URL=postgresql://user:pass@host:5432/dentos \
  dentos-web:latest
```

## ☁️ Vercel Deployment

### Step 1: Prepare Repository

```bash
# Push to GitHub
git push origin main

# Create Vercel project
vercel link
```

### Step 2: Environment Variables

Set in Vercel Dashboard → Settings → Environment Variables:

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_key
DATABASE_URL=postgresql://user:pass@host:5432/dentos
```

### Step 3: Deploy

```bash
# Automatic deployment on push
git push origin main

# Or manual deployment
vercel deploy --prod
```

Visit: `https://dentos-web.vercel.app`

## 🌐 AWS Deployment (ECS + RDS)

### 1. Create RDS PostgreSQL Instance

```bash
# Via AWS Console or CLI
aws rds create-db-instance \
  --db-instance-identifier dentos-db \
  --db-instance-class db.t3.micro \
  --engine postgres \
  --master-username postgres \
  --master-user-password <strong-password> \
  --allocated-storage 20 \
  --vpc-security-group-ids sg-xxxxx
```

### 2. Push Docker Image to ECR

```bash
# Create ECR repository
aws ecr create-repository --repository-name dentos-web

# Build and push
docker build -t dentos-web:latest .
docker tag dentos-web:latest <account-id>.dkr.ecr.us-east-1.amazonaws.com/dentos-web:latest
aws ecr get-login-password | docker login --username AWS --password-stdin <account-id>.dkr.ecr.us-east-1.amazonaws.com
docker push <account-id>.dkr.ecr.us-east-1.amazonaws.com/dentos-web:latest
```

### 3. Create ECS Service

```bash
# Create ECS task definition
aws ecs register-task-definition \
  --family dentos-web \
  --container-definitions file://task-definition.json

# Create service
aws ecs create-service \
  --cluster dentos-cluster \
  --service-name dentos-web \
  --task-definition dentos-web:1 \
  --desired-count 2
```

## 📱 Mobile App Deployment

### iOS (Apple App Store)

```bash
# Build for production
cd apps/mobile
eas build --platform ios --auto-submit

# Or submit manually
eas submit --platform ios
```

### Android (Google Play Store)

```bash
eas build --platform android --auto-submit
# Or
eas submit --platform android
```

## 🔐 Environment Variables

### Required
```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_key
SUPABASE_SERVICE_ROLE_KEY=your_service_key

# Database
DATABASE_URL=postgresql://user:pass@host:5432/dentos
```

### Optional (Production)
```env
# Netgsm SMS
NETGSM_API_KEY=your_key
NETGSM_API_SECRET=your_secret

# Iyzico Payment
IYZICO_API_KEY=your_key
IYZICO_API_SECRET=your_secret

# E-Arşiv (Turkish Tax)
EARSIV_USERNAME=your_username
EARSIV_PASSWORD=your_password

# Analytics
NEXT_PUBLIC_GA_ID=UA-XXXXX-Y
SENTRY_DSN=your_sentry_url

# Cache
REDIS_URL=redis://host:6379

# Email
SENDGRID_API_KEY=your_key
SENDGRID_FROM_EMAIL=noreply@klinikmerkezi.com.tr
```

## 🚨 Health Checks

### Application Health

```bash
# Check API is running
curl http://localhost:3000/api/health

# Check database connection
curl http://localhost:3000/api/health/db

# Check Supabase connection
curl http://localhost:3000/test-connection
```

### Database Health

```bash
# Connect to database
psql postgresql://postgres:password@localhost:5432/dentos

# Check tables
\dt

# Check migrations applied
SELECT * FROM _drizzle_migrations;
```

## 📊 Monitoring & Logging

### Docker Logs
```bash
docker-compose logs -f --tail=100 postgres
docker-compose logs -f --tail=100 redis
```

### Application Logs
```bash
# View server logs
pm2 logs dentos-web

# View with filtering
pm2 logs dentos-web | grep ERROR
```

### Database Logs
```bash
# PostgreSQL logs
docker exec dentos-postgres tail -f /var/log/postgresql/postgresql.log
```

## 🔄 CI/CD Pipeline

### GitHub Actions

File: `.github/workflows/deploy.yml`

```yaml
name: Deploy to Production

on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'pnpm'
      
      - run: pnpm install
      - run: pnpm build
      - run: pnpm test
      
      - name: Deploy to Vercel
        run: vercel --prod
        env:
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
```

## 🔒 Security Checklist

- [ ] Environment variables set in production
- [ ] Database password is strong (20+ chars, special chars)
- [ ] RLS (Row Level Security) enabled on all tables
- [ ] Rate limiting configured on APIs
- [ ] CORS properly configured
- [ ] Secrets rotation scheduled (monthly)
- [ ] Database backups automated (daily)
- [ ] SSL/TLS certificates valid
- [ ] DDoS protection enabled (CloudFlare/AWS WAF)
- [ ] Security scanning in CI/CD pipeline

## 🆘 Troubleshooting

### Database Connection Fails
```bash
# Check DATABASE_URL format
echo $DATABASE_URL

# Test connection
psql $DATABASE_URL

# Check network connectivity
nslookup db.knzrcgqpzjbajfboqlhq.supabase.co
```

### Migrations Not Applied
```bash
# Check migration status
docker-compose exec postgres psql -U postgres -d dentos
SELECT * FROM _drizzle_migrations;

# Manually apply migration
psql $DATABASE_URL < packages/db/migrations/0001_init.sql
```

### Out of Memory
```bash
# Increase Docker memory
docker-compose down
docker-compose up -d --memory=4g postgres
```

## 📞 Support

- Issues: https://github.com/zekeriyaalpyildiran-art/dentos/issues
- Documentation: See README.md and DATABASE_SETUP.md
- Status: Check Supabase dashboard and GitHub Actions

---

**Last Updated:** October 7, 2026
**Version:** 1.0.0
