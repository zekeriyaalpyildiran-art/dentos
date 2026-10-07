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
  --storage-encrypted \
  --backup-retention-period 30 \
  --multi-az \
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

### 3. Create ECS Service with Auto Scaling

```bash
# Create ECS cluster
aws ecs create-cluster --cluster-name dentos-prod

# Register task definition
aws ecs register-task-definition \
  --family dentos-web \
  --network-mode awsvpc \
  --requires-compatibilities FARGATE \
  --cpu 256 \
  --memory 512 \
  --container-definitions file://task-definition.json

# Create service
aws ecs create-service \
  --cluster dentos-prod \
  --service-name dentos-web \
  --task-definition dentos-web:1 \
  --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx],securityGroups=[sg-xxx]}"

# Configure auto scaling (CPU-based)
aws application-autoscaling register-scalable-target \
  --service-namespace ecs \
  --resource-id service/dentos-prod/dentos-web \
  --scalable-dimension ecs:service:DesiredCount \
  --min-capacity 2 \
  --max-capacity 10

aws application-autoscaling put-scaling-policy \
  --policy-name cpu-scaling \
  --service-namespace ecs \
  --resource-id service/dentos-prod/dentos-web \
  --scalable-dimension ecs:service:DesiredCount \
  --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration '{
    "TargetValue": 70.0,
    "PredefinedMetricSpecification": {
      "PredefinedMetricType": "ECSServiceAverageCPUUtilization"
    }
  }'
```

## 📦 Kubernetes Deployment (Advanced)

### Helm Chart Setup

**values.yaml:**
```yaml
replicaCount: 3

image:
  repository: ghcr.io/zekeriyaalpyildiran-art/dentos
  tag: "latest"
  pullPolicy: IfNotPresent

service:
  type: LoadBalancer
  port: 80
  targetPort: 3000

ingress:
  enabled: true
  className: nginx
  hosts:
    - host: dentos.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: dentos-tls
      hosts:
        - dentos.example.com

autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 10
  targetCPUUtilizationPercentage: 70

resources:
  limits:
    cpu: 500m
    memory: 512Mi
  requests:
    cpu: 250m
    memory: 256Mi
```

**Deploy:**
```bash
# Create namespace
kubectl create namespace dentos

# Create secrets
kubectl create secret generic dentos-secrets \
  --from-literal=database-url=postgresql://... \
  -n dentos

# Install Helm chart
helm install dentos ./helm/dentos \
  --namespace dentos \
  --values values.yaml

# Monitor deployment
kubectl get pods -n dentos
kubectl logs -n dentos -l app=dentos --tail=100
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

## 🔄 Advanced CI/CD Pipeline

### GitHub Actions - Comprehensive Deployment

File: `.github/workflows/deploy.yml`

```yaml
name: Deploy to Production

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'pnpm'
      
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm type-check
      - run: pnpm test
      
  build:
    needs: quality
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v3
      - name: Build Docker image
        run: docker build -t ghcr.io/${{ github.repository }}:${{ github.sha }} .
      
      - name: Push to registry
        run: |
          echo ${{ secrets.GITHUB_TOKEN }} | docker login ghcr.io -u ${{ github.actor }} --password-stdin
          docker push ghcr.io/${{ github.repository }}:${{ github.sha }}
          docker tag ghcr.io/${{ github.repository }}:${{ github.sha }} ghcr.io/${{ github.repository }}:latest
          docker push ghcr.io/${{ github.repository }}:latest
  
  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to Vercel
        run: vercel --prod --token ${{ secrets.VERCEL_TOKEN }}
      
      - name: Notify Slack
        run: |
          curl -X POST https://hooks.slack.com/services/YOUR/HOOK/URL \
            -d '{"text":"✅ DentOS deployed successfully"}'
```

## 🔄 Backup & Disaster Recovery

### Automated Backup Strategy

**Daily backup script:**
```bash
#!/bin/bash
# backup-dentos.sh

BACKUP_DIR="/backups"
DATE=$(date +%Y-%m-%d-%H%M%S)
DB_BACKUP="dentos-backup-${DATE}.sql"

# Database backup
pg_dump $DATABASE_URL > "${BACKUP_DIR}/${DB_BACKUP}"

# Compress and encrypt
gpg --symmetric --cipher-algo AES256 "${BACKUP_DIR}/${DB_BACKUP}"

# Upload to S3
aws s3 cp "${BACKUP_DIR}/${DB_BACKUP}.gpg" s3://dentos-backups/

# Keep only last 7 backups locally
find $BACKUP_DIR -name "dentos-backup-*.sql*" -mtime +7 -delete

# Upload to Glacier for archival (weekly)
if [ $(date +%u) -eq 0 ]; then
  aws glacier upload-archive \
    --vault-name dentos-backups \
    --body "${BACKUP_DIR}/${DB_BACKUP}.gpg"
fi
```

**Schedule with cron:**
```bash
0 2 * * * /scripts/backup-dentos.sh
```

### Restore from Backup

```bash
# List available backups
aws s3 ls s3://dentos-backups/

# Download and decrypt
aws s3 cp s3://dentos-backups/dentos-backup-2026-10-07.sql.gpg .
gpg dentos-backup-2026-10-07.sql.gpg

# Restore to database
psql $DATABASE_URL < dentos-backup-2026-10-07.sql
```

### Recovery Time Objectives (RTO)

| Component | RTO | Recovery Method |
|-----------|-----|-----------------|
| Database | 1 hour | Restore from S3 backup |
| Web app | 15 minutes | Redeploy from container |
| All data | 24 hours | Restore from Glacier |

## 🚀 Performance Optimization

### CDN Setup (Cloudflare)

```bash
# 1. Add domain to Cloudflare
# 2. Enable:
#    - Full SSL/TLS encryption
#    - Brotli compression
#    - Automatic HTTPS redirect
#    - HTTP/2 and HTTP/3
#    - Image optimization

# 3. Set caching rules
#    /api/* → No cache
#    /static/* → Cache 1 year
#    / → Cache 1 hour
```

### Database Query Optimization

```sql
-- Index frequently queried columns
CREATE INDEX idx_patients_clinic_id ON patients(clinic_id);
CREATE INDEX idx_appointments_clinic_id_date ON appointments(clinic_id, appointment_date);
CREATE INDEX idx_treatment_plans_patient_id ON treatment_plans(patient_id);

-- Analyze query performance
EXPLAIN ANALYZE SELECT * FROM appointments WHERE clinic_id = '...';
```

## 🆘 Troubleshooting

### Database Connection Fails
```bash
# Check DATABASE_URL format
echo $DATABASE_URL

# Test connection
psql $DATABASE_URL

# Check network connectivity
nslookup db.knzrcgqpzjbajfboqlhq.supabase.co

# Check security groups (AWS)
aws ec2 describe-security-groups --group-ids sg-xxxxx
```

### Deployment Stuck
```bash
# Check GitHub Actions logs
gh run list --repo zekeriyaalpyildiran-art/dentos
gh run view <run-id>

# Check Vercel deployment
vercel logs --tail

# Cancel and retry
gh run cancel <run-id>
git commit --allow-empty -m "Retry deployment"
git push origin main
```

### High Memory Usage
```bash
# Check container memory
docker stats dentos

# Increase memory limit
docker run -m 2g -e JAVA_OPTS="-Xmx1800m" dentos:latest

# Or in Kubernetes
kubectl set resources deployment dentos --limits=memory=2Gi
```

### Database Query Slow
```bash
# Enable query logging
SET log_statement = 'all';
SET log_duration = on;

# Check slow queries
SELECT * FROM pg_stat_statements 
ORDER BY mean_exec_time DESC 
LIMIT 10;

# Create missing index
REINDEX TABLE patients;
ANALYZE patients;
```

### API Rate Limiting Issues
```bash
# Check rate limit headers
curl -v https://dentos.example.com/api/patients | grep X-RateLimit

# Increase limits in production
# Rate limit settings in apps/web/src/middleware.ts
```

## 📊 Monitoring Dashboard

### Key Metrics to Monitor

```
Application:
- Request latency (p50, p95, p99)
- Error rate (5xx, 4xx)
- Throughput (requests/sec)
- User sessions

Database:
- Query response time
- Connection count
- Disk usage
- Replication lag

Infrastructure:
- CPU utilization
- Memory usage
- Disk I/O
- Network bandwidth
```

## 📞 Support & Resources

- **Issues:** https://github.com/zekeriyaalpyildiran-art/dentos/issues
- **Documentation:** See README.md, FEATURES.md, API.md
- **Security:** See SECURITY.md for security guidelines
- **Status:** Check GitHub Actions and Vercel dashboard

---

**Last Updated:** October 7, 2026  
**Version:** 2.0.0  
**Maintained By:** DevOps & Infrastructure Team
