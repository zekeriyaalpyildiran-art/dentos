# ⚡ DentOS Performance & Optimization Guide

Complete guide for optimizing DentOS performance across all layers.

---

## 📊 Performance Targets

### Web Application
- **First Contentful Paint (FCP):** < 1.5s
- **Largest Contentful Paint (LCP):** < 2.5s
- **Time to Interactive (TTI):** < 3.5s
- **Cumulative Layout Shift (CLS):** < 0.1
- **API Response Time:** < 200ms (p95)

### Database
- **Query Response Time:** < 50ms (p95)
- **Connection Pool:** 20-50 connections
- **CPU Utilization:** < 70%
- **Memory Usage:** < 80%

### Mobile App
- **App Launch Time:** < 3 seconds
- **Screen Navigation:** < 500ms
- **API Calls:** < 300ms

---

## 🚀 Frontend Optimization

### Code Splitting & Lazy Loading

**Next.js dynamic imports:**
```typescript
import dynamic from 'next/dynamic';

// Lazy load admin components
const AdminUsers = dynamic(() => import('@/components/admin/Users'), {
  loading: () => <div>Loading...</div>,
  ssr: false
});

export default function AdminPage() {
  return <AdminUsers />;
}
```

### Image Optimization

**Using Next.js Image component:**
```typescript
import Image from 'next/image';

export function PatientAvatar({ src, alt }) {
  return (
    <Image
      src={src}
      alt={alt}
      width={64}
      height={64}
      priority={false}
      placeholder="blur"
      blurDataURL="data:image/svg+xml,..."
    />
  );
}
```

**Image format optimization:**
```bash
# Convert images to WebP
cwebp input.png -o output.webp

# Optimize PNG/JPEG
optipng -o2 image.png
jpegoptim --max=90 image.jpg
```

### CSS & JavaScript Optimization

**Minimize CSS:**
```bash
# Production CSS (auto with Tailwind)
pnpm build
# Output CSS is automatically minified and purged

# Check CSS file size
ls -lh .next/static/css/
```

**JavaScript minification:**
```bash
# Already handled by Next.js build
# Verify bundle size
pnpm analyze

# Or use webpack-bundle-analyzer
npm install --save-dev webpack-bundle-analyzer
```

### Caching Strategies

**Browser caching headers:**
```typescript
// apps/web/src/middleware.ts
export function middleware(request: NextRequest) {
  const response = NextResponse.next();

  // Static assets: 1 year
  if (request.nextUrl.pathname.startsWith('/static/')) {
    response.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  }

  // API routes: No cache
  if (request.nextUrl.pathname.startsWith('/api/')) {
    response.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }

  // HTML pages: 1 hour
  response.headers.set('Cache-Control', 'public, max-age=3600, s-maxage=3600');

  return response;
}
```

**ISR (Incremental Static Regeneration):**
```typescript
// Revalidate every hour
export const revalidate = 3600;

export default function DashboardPage() {
  return <div>Dashboard</div>;
}
```

---

## 🗄️ Database Optimization

### Indexing Strategy

**Essential indexes:**
```sql
-- Fast patient lookups
CREATE INDEX idx_patients_clinic_id 
  ON patients(clinic_id) 
  WHERE deleted_at IS NULL;

-- Appointment scheduling
CREATE INDEX idx_appointments_clinic_date 
  ON appointments(clinic_id, appointment_date, start_time);

-- Patient search
CREATE INDEX idx_patients_search 
  ON patients USING GIN(
    to_tsvector('turkish', full_name)
  );

-- Treatment plan queries
CREATE INDEX idx_treatment_plans_patient 
  ON treatment_plans(patient_id, created_at DESC);

-- Verify indexes exist
SELECT * FROM pg_indexes WHERE schemaname = 'public';
```

### Query Optimization

**N+1 Query Prevention:**
```typescript
// ❌ Bad - N+1 queries
const appointments = await db.select().from(appointments);
for (const app of appointments) {
  const patient = await db.select().from(patients)
    .where(eq(patients.id, app.patient_id));
}

// ✅ Good - Single join query
const appointments = await db
  .select()
  .from(appointments)
  .leftJoin(patients, eq(appointments.patient_id, patients.id));
```

**Query result caching:**
```typescript
import { cache } from 'react';

// Cache at request level (ISR)
export const getCachedPatient = cache(async (patientId: string) => {
  return await db.select()
    .from(patients)
    .where(eq(patients.id, patientId))
    .limit(1);
});

// Use in multiple places - only queries once per request
```

### Connection Pooling

**Database connection configuration:**
```typescript
// apps/web/src/lib/db.ts
import { Pool } from 'pg';

const pool = new Pool({
  max: 20,              // Max connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

export const db = pool;
```

### Statistics & Vacuum

**Schedule maintenance:**
```bash
# Weekly VACUUM and ANALYZE
0 2 * * 0 psql $DATABASE_URL -c "VACUUM ANALYZE;"

# Monitor table sizes
SELECT 
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
```

---

## 🔄 Caching Layer

### Redis Configuration

**Session caching:**
```typescript
import redis from '@/lib/redis';

// Cache session for 24 hours
export async function getSession(sessionId: string) {
  const cached = await redis.get(`session:${sessionId}`);
  if (cached) return JSON.parse(cached);

  const session = await db.select().from(sessions)
    .where(eq(sessions.id, sessionId));

  await redis.setex(`session:${sessionId}`, 86400, JSON.stringify(session));
  return session;
}
```

**API response caching:**
```typescript
// Cache API responses for 5 minutes
export async function getCachedAppointments(clinicId: string) {
  const key = `appointments:${clinicId}`;
  
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);

  const appointments = await db.select()
    .from(appointments)
    .where(eq(appointments.clinic_id, clinicId));

  await redis.setex(key, 300, JSON.stringify(appointments));
  return appointments;
}
```

**Cache invalidation:**
```typescript
export async function createAppointment(data: AppointmentData) {
  const appointment = await db.insert(appointments).values(data);
  
  // Invalidate related caches
  await redis.del(`appointments:${data.clinic_id}`);
  await redis.del(`calendar:${data.clinic_id}`);
  
  return appointment;
}
```

---

## 📱 Mobile App Performance

### App Startup Optimization

**Lazy load screens:**
```typescript
// App.tsx
import { lazy, Suspense } from 'react';

const AppointmentsScreen = lazy(() => import('./screens/Appointments'));
const BookingScreen = lazy(() => import('./screens/Booking'));

export default function App() {
  return (
    <Suspense fallback={<SplashScreen />}>
      <AppointmentsScreen />
      <BookingScreen />
    </Suspense>
  );
}
```

### API Response Caching

**Mobile offline support:**
```typescript
import AsyncStorage from '@react-native-async-storage/async-storage';

export async function getCachedAppointments() {
  try {
    // Try online first
    const response = await fetch('/api/appointments');
    const data = await response.json();
    
    // Cache for offline
    await AsyncStorage.setItem('appointments', JSON.stringify(data));
    return data;
  } catch (error) {
    // Fall back to cached data
    const cached = await AsyncStorage.getItem('appointments');
    return cached ? JSON.parse(cached) : [];
  }
}
```

### Minimal Bundle Size

**Monitor bundle:**
```bash
# Check dependencies
npm ls --depth=0

# Remove unused packages
npm prune

# Check bundle analyzer
expo-optimize

# Measure binary size
eas build --platform android --measure
```

---

## 🌐 API Optimization

### Rate Limiting

**Implement rate limiting:**
```typescript
import { Ratelimit } from '@upstash/ratelimit';

const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(100, '1 m'),
});

export async function POST(request: Request) {
  const ip = request.headers.get('x-forwarded-for');
  const { success } = await ratelimit.limit(ip!);

  if (!success) {
    return new Response('Rate limited', { status: 429 });
  }

  // Handle request
}
```

### Pagination

**Optimize large result sets:**
```typescript
// Limit default page size
const limit = Math.min(parseInt(query.limit) || 50, 100);
const offset = (parseInt(query.offset) || 0);

const patients = await db.select()
  .from(patients)
  .where(eq(patients.clinic_id, clinicId))
  .limit(limit)
  .offset(offset);

return {
  data: patients,
  total: count,
  limit,
  offset,
  hasMore: offset + limit < count
};
```

### Compression

**Enable gzip/brotli:**
```typescript
// Next.js automatically enables compression
// Verify in production:
curl -H "Accept-Encoding: gzip, deflate, br" \
  -I https://dentos.example.com | grep Content-Encoding
```

---

## 🔍 Monitoring & Profiling

### Performance Metrics Collection

**Track Web Vitals:**
```typescript
import { getCLS, getFID, getFCP, getLCP, getTTFB } from 'web-vitals';

function sendToAnalytics(metric: any) {
  console.log(metric);
  // Send to analytics service
  fetch('/api/metrics', {
    method: 'POST',
    body: JSON.stringify(metric)
  });
}

getCLS(sendToAnalytics);
getFID(sendToAnalytics);
getFCP(sendToAnalytics);
getLCP(sendToAnalytics);
getTTFB(sendToAnalytics);
```

### Database Profiling

**Identify slow queries:**
```sql
-- Enable slow query logging
SET log_min_duration_statement = 1000; -- Log queries > 1s

-- View top slow queries
SELECT query, calls, mean_exec_time 
FROM pg_stat_statements 
ORDER BY mean_exec_time DESC 
LIMIT 10;

-- Explain query plan
EXPLAIN ANALYZE SELECT * FROM appointments 
WHERE clinic_id = '...' AND appointment_date > NOW();
```

### Real User Monitoring (RUM)

**Setup Sentry:**
```typescript
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 1.0,
  integrations: [
    new Sentry.Replay({
      maskAllText: true,
      blockAllMedia: true,
    }),
  ],
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
});
```

---

## 🚀 Deployment Performance

### Build Optimization

**Optimize Next.js build:**
```bash
# Analyze build
pnpm build --analyze

# Check build time
time pnpm build

# Check output directory size
du -sh .next
```

**Dockerfile optimization:**
```dockerfile
# Multi-stage build
FROM node:18-alpine AS dependencies
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile

FROM node:18-alpine AS builder
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# Minimal production image
FROM node:18-alpine
WORKDIR /app
RUN npm install -g pnpm

COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=dependencies /app/node_modules ./node_modules

CMD ["pnpm", "start"]
```

### CDN Configuration

**Cloudflare caching rules:**
```
# API endpoints: No cache
api.example.com/* → Cache Level: Bypass

# Static assets: Cache 1 year
example.com/static/* → Cache Level: Cache Everything
Cache TTL: 1 year

# HTML pages: Cache 1 hour
example.com/* → Cache Level: Cache Everything
Cache TTL: 1 hour

# Enable compression
Brotli: On
Minify CSS/JS/HTML: On
```

---

## 📈 Benchmarking

### Load Testing

**Using Apache Bench:**
```bash
# 1000 requests, 10 concurrent
ab -n 1000 -c 10 https://dentos.example.com/

# POST request with data
ab -n 100 -c 5 -T "application/json" \
   -p data.json https://dentos.example.com/api/appointments
```

**Using k6:**
```javascript
// load-test.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export let options = {
  stages: [
    { duration: '30s', target: 100 },
    { duration: '1m30s', target: 100 },
    { duration: '20s', target: 0 },
  ],
};

export default function () {
  let response = http.get('https://dentos.example.com/api/appointments');
  check(response, {
    'status is 200': (r) => r.status === 200,
    'response time < 500ms': (r) => r.timings.duration < 500,
  });
  sleep(1);
}
```

Run: `k6 run load-test.js`

---

## 🎯 Performance Checklist

### Development
- [ ] Use React.memo for expensive components
- [ ] Implement image lazy loading
- [ ] Use dynamic imports for large components
- [ ] Optimize bundle size (analyze output)
- [ ] Implement proper caching headers
- [ ] Use database indexes appropriately
- [ ] Profile database queries

### Deployment
- [ ] Enable gzip/brotli compression
- [ ] Configure CDN caching
- [ ] Setup database replication
- [ ] Configure connection pooling
- [ ] Enable query result caching
- [ ] Setup Redis for sessions
- [ ] Enable slow query logging

### Monitoring
- [ ] Track Core Web Vitals
- [ ] Monitor API response times
- [ ] Track database query performance
- [ ] Setup error tracking (Sentry)
- [ ] Monitor infrastructure metrics
- [ ] Setup alerts for anomalies
- [ ] Schedule regular load tests

---

## 📚 Additional Resources

- [Web Vitals](https://web.dev/vitals/)
- [Next.js Performance](https://nextjs.org/docs/advanced-features/measuring-performance)
- [PostgreSQL Performance](https://www.postgresql.org/docs/current/performance-tips.html)
- [Redis Caching](https://redis.io/docs/manual/client-side-caching/)
- [k6 Load Testing](https://k6.io/docs/)

---

**Last Updated:** October 7, 2026  
**Version:** 1.0.0  
**Maintained By:** Performance Team
