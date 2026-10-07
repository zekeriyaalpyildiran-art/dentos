# 🔧 DentOS Troubleshooting & FAQ

Comprehensive troubleshooting guide for common issues in DentOS.

---

## 🚀 Startup Issues

### Application Won't Start

**Problem:** Port 3000 already in use

```bash
# Find process using port 3000
lsof -i :3000

# Kill the process
kill -9 <PID>

# Or use different port
PORT=3001 pnpm dev
```

**Problem:** Dependencies not installed

```bash
# Clear node_modules and reinstall
rm -rf node_modules pnpm-lock.yaml
pnpm install --frozen-lockfile

# For Docker
docker-compose down -v
docker-compose up -d
```

**Problem:** Environment variables not set

```bash
# Check if .env.local exists
ls -la .env.local

# Create from example
cp .env.example .env.local
# Edit and fill in values
nano .env.local

# Verify variables are loaded
grep DATABASE_URL .env.local
```

---

## 🗄️ Database Issues

### Cannot Connect to Database

**Problem:** Connection timeout

```bash
# Test connection string
psql $DATABASE_URL

# Check if database server is running
# For Docker:
docker-compose ps postgres

# For AWS RDS:
aws rds describe-db-instances --db-instance-identifier dentos-db

# Check security groups (AWS)
aws ec2 describe-security-groups --group-ids sg-xxxxx
```

**Problem:** Wrong database credentials

```bash
# Verify DATABASE_URL format
echo $DATABASE_URL
# Should be: postgresql://user:password@host:5432/database

# Test each component
psql -h localhost -U postgres -d dentos -c "SELECT 1;"

# Check password special characters are URL-encoded
# @ = %40, : = %3A, etc.
```

### Migrations Failed

**Problem:** Migration schema mismatch

```bash
# Check migration status
psql $DATABASE_URL -c "SELECT * FROM _drizzle_migrations;"

# Manually apply migration
psql $DATABASE_URL < migrations/0001_init.sql

# Reset database (⚠️ Deletes all data)
psql $DATABASE_URL -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
psql $DATABASE_URL < migrations/0001_init.sql
```

**Problem:** Drizzle ORM issues

```bash
# Clear Drizzle cache
rm -rf .drizzle

# Regenerate migrations
pnpm drizzle-kit generate:pg

# Apply migrations
pnpm drizzle-kit migrate:pg
```

### Slow Queries

**Problem:** Database query performance

```bash
# Check for missing indexes
psql $DATABASE_URL << EOF
-- View existing indexes
SELECT * FROM pg_indexes WHERE schemaname = 'public';

-- Create missing index
CREATE INDEX idx_appointments_date 
ON appointments(appointment_date) 
WHERE deleted_at IS NULL;
EOF

# Analyze query plan
EXPLAIN ANALYZE 
SELECT * FROM appointments 
WHERE clinic_id = '11111111-1111-1111-1111-111111111111' 
AND appointment_date > NOW();
```

**Problem:** Connection pool exhausted

```bash
# Check active connections
psql $DATABASE_URL -c "SELECT * FROM pg_stat_activity;"

# Kill idle connections
psql $DATABASE_URL -c "
SELECT pg_terminate_backend(pid) 
FROM pg_stat_activity 
WHERE usename = 'postgres' AND state = 'idle';
"

# Increase pool size in code (max 50)
```

---

## 🔐 Authentication Issues

### Cannot Login

**Problem:** OTP not received

```bash
# Check SMS gateway status
curl http://localhost:3000/api/health
# Should show SMS gateway status

# Verify Netgsm configuration
echo $NETGSM_API_KEY
echo $NETGSM_API_SECRET

# Test SMS sending
curl -X POST http://localhost:3000/api/notifications/sms/send \
  -H "Content-Type: application/json" \
  -d '{
    "phone_number": "+90 555 123-4567",
    "message": "Test OTP: 123456"
  }'
```

**Problem:** Session expired

```bash
# Clear browser cache and cookies
# Chrome: Settings → Privacy & Security → Clear Browsing Data

# Logout and login again
# Mobile: Force close app and reopen
```

**Problem:** "Invalid token" error

```bash
# Check JWT_SECRET is set
echo $JWT_SECRET

# Verify token format
# Authorization: Bearer eyJhbGciOiJIUzI1NiIs...

# Check token expiry
# Tokens expire after 24 hours
# Use refresh token to get new token
```

---

## 👤 Patient Management Issues

### Patient Not Showing in List

**Problem:** KVKK consent not given

```bash
# Check patient KVKK status
psql $DATABASE_URL << EOF
SELECT id, full_name, kvkk_consent, kvkk_consent_date 
FROM patients 
WHERE full_name = 'Ahmet Yılmaz';
EOF

# Update consent (use with care)
UPDATE patients 
SET kvkk_consent = true, kvkk_consent_date = NOW()
WHERE id = '...';
```

**Problem:** Patient belongs to different clinic

```bash
# List patients by clinic
psql $DATABASE_URL << EOF
SELECT id, full_name, clinic_id 
FROM patients 
WHERE clinic_id = '11111111-1111-1111-1111-111111111111';
EOF

# Note: This is correct behavior - patients are clinic-isolated
```

### Cannot Update Patient

**Problem:** Permission denied

```bash
# Check user role
SELECT role FROM users WHERE id = current_user_id;

# Patient data can be updated by:
# - Admin (all patients)
# - Doctor (assigned patients)
# - Receptionist (contact info only)
```

**Problem:** Invalid data format

```bash
# Check field constraints
# full_name: required, 3-255 chars
# email: valid email format
# phone: +90 format for Turkey
# birth_date: YYYY-MM-DD format
# identity_number: 11 digits

# Example valid data:
{
  "full_name": "Ahmet Yılmaz",
  "email": "ahmet@example.com",
  "phone": "+90 555 123-4567",
  "birth_date": "1985-03-15",
  "identity_number": "12345678901"
}
```

---

## 📅 Appointment Issues

### Appointment Conflicts

**Problem:** "Time slot not available"

```bash
# Check existing appointments
psql $DATABASE_URL << EOF
SELECT * FROM appointments 
WHERE doctor_id = '...'
AND appointment_date = '2026-10-08'
AND start_time < '10:00' AND end_time > '09:30';
EOF

# System prevents double-booking automatically
# Choose different time slot
```

**Problem:** Appointment in the past

```bash
# Cannot create appointments before current date/time
# Appointment date must be >= today

# For scheduling: use future dates
appointment_date: '2026-10-15' (or later)
```

### Cannot Reschedule

**Problem:** Less than 24 hours before appointment

```bash
# Rescheduling policy:
# 24+ hours before: Free reschedule
# Less than 24 hours: Charged as cancellation

# For appointments within 24 hours:
# - Contact clinic directly
# - Admin can force reschedule (charges apply)
```

**Problem:** Doctor not available

```bash
# Check doctor schedule
psql $DATABASE_URL << EOF
SELECT schedule FROM users WHERE id = '...' AND role = 'doctor';
EOF

# Default schedule: 09:00-12:00, 14:00-18:00
# Contact clinic to modify doctor schedule
```

---

## 💰 Payment Issues

### Payment Failed

**Problem:** Card rejected

```bash
# Try these steps:
1. Verify card details are correct
2. Try different card (if available)
3. Check card expiry date
4. Verify card has sufficient balance
5. Contact bank about 3D Secure

# Test cards (Iyzico demo):
Visa: 5555555555554444, CVC: 123
Mastercard: 5406675399999016, CVC: 123
```

**Problem:** Payment appears twice

```bash
# Check payment history
psql $DATABASE_URL << EOF
SELECT id, amount, status, created_at 
FROM payments 
WHERE patient_id = '...'
ORDER BY created_at DESC;
EOF

# If duplicate: Contact support to refund duplicate charge
```

**Problem:** Balance still shows outstanding

```bash
# Refresh browser to see updated balance
# Clear cache: Ctrl+Shift+R (Chrome)

# Check payment was processed
curl -H "Authorization: Bearer TOKEN" \
  http://localhost:3000/api/payments/history/patient-id
```

---

## 🧪 Lab Orders Issues

### Lab Order Not Received

**Problem:** Lab order stuck in pending

```bash
# Check order status
psql $DATABASE_URL << EOF
SELECT id, status, created_at, expected_delivery 
FROM lab_orders 
WHERE patient_id = '...'
ORDER BY created_at DESC;
EOF

# Update status if needed
UPDATE lab_orders 
SET status = 'processing' 
WHERE id = '...';
```

**Problem:** Delivery date passed

```bash
# Check expected delivery
psql $DATABASE_URL << EOF
SELECT expected_delivery, status FROM lab_orders 
WHERE id = '...';
EOF

# Contact lab about delivery status
# Update expected_delivery if rescheduled
```

---

## 📱 Mobile App Issues

### App Crashes on Startup

**Problem:** Incompatible version

```bash
# Clear app cache
iOS: Settings → General → Storage → DentOS → Offload App
Android: Settings → Apps → DentOS → Clear Cache

# Reinstall app
iOS: Delete from home screen, reinstall from App Store
Android: Settings → Apps → DentOS → Uninstall, reinstall
```

**Problem:** Insufficient storage

```bash
# App requires 50MB free space
# On mobile device:
iOS: Settings → General → Storage
Android: Settings → Storage

# Clear space or uninstall unused apps
```

### Cannot Login on Mobile

**Problem:** Network timeout

```bash
# Check internet connection
- WiFi: Reconnect to network
- Mobile data: Turn off/on

# Restart phone
# Try again in 5 minutes
```

**Problem:** OTP not arriving

```bash
# Verify phone number format: +90 5XX XXX XXXX

# Check SMS permissions:
iOS: Settings → DentOS → Messages
Android: Settings → Apps → DentOS → Permissions → SMS

# Try email verification as fallback
```

### Notifications Not Working

**Problem:** Notifications disabled

```bash
# Enable notifications:
iOS: Settings → Notifications → DentOS → Allow
Android: Settings → Apps → DentOS → Notifications → Allow

# Reinstall app if still not working
```

---

## 🖥️ Admin Dashboard Issues

### Cannot Access Admin Panel

**Problem:** Insufficient permissions

```bash
# Only Admin role can access /admin/*
# Check your role:
Dashboard → Profile → Role

# Contact clinic owner to grant admin access
```

**Problem:** Settings not saving

```bash
# Ensure all required fields are filled
# Check browser console for errors: F12

# Try again with valid data:
- Clinic name: Required
- Phone: +90 format
- Email: Valid email
- Working hours: 24-hour format
```

### Users not appearing in list

**Problem:** Filter applied

```bash
# Check if filters are active
# Reset filters:
Users page → Clear Filters / Reset

# Search by name or email
```

---

## 🐛 General Debugging

### Check Application Logs

**Local development:**
```bash
# Terminal logs
pnpm dev
# Look for error messages

# Browser console (F12)
# - Errors (red)
# - Warnings (yellow)
# - Network tab for API failures

# Mobile (Expo)
pnpm -F mobile start
# Scan QR with Expo Go
# Shake phone → View logs
```

**Production:**
```bash
# Vercel logs
vercel logs --tail

# Docker logs
docker-compose logs -f web

# Cloud logs
# AWS CloudWatch → /aws/ecs/dentos
# Sentry dashboard → Issues
```

### Network Issues

**Check API connectivity:**
```bash
# Test API endpoint
curl -H "Authorization: Bearer TOKEN" \
  http://localhost:3000/api/health

# Check response time
curl -w "Time: %{time_total}s\n" \
  http://localhost:3000/api/appointments

# View network requests (Browser DevTools)
# F12 → Network tab
# Filter by Failed requests
```

### Performance Issues

**Slow page load:**
```bash
# Check browser console for errors (F12)
# Check Network tab → Slow requests
# Profile in DevTools → Performance tab

# Clear cache: Ctrl+Shift+R
# Try different browser
# Check internet speed
```

**Slow API responses:**
```bash
# Check database performance
psql $DATABASE_URL -c "SELECT * FROM pg_stat_statements LIMIT 10;"

# Check server CPU/Memory
docker stats
# or
ps aux | grep node

# Check rate limiting
curl -I http://localhost:3000/api/appointments | grep X-RateLimit
```

---

## 📞 Getting Help

### Provide Error Details

When reporting issues, include:

```
- Error message (exact text)
- Steps to reproduce
- Screenshots/videos
- Browser/device info
- Log output (relevant parts)
- What you've already tried
```

### Common Support Channels

```
1. GitHub Issues
   https://github.com/zekeriyaalpyildiran-art/dentos/issues

2. Email Support
   support@example.com

3. Documentation
   README.md, API.md, SECURITY.md

4. Clinic Administrator
   For clinic-specific issues
```

### Emergency Support

```
For critical production issues:
1. Contact clinic administrator
2. Check system status page
3. Restart affected service
4. Check recent deployments
5. Restore from backup if needed
```

---

## ✅ Verification Checklist

After fixing an issue:

- [ ] Issue is reproducible in multiple browsers
- [ ] No error messages in browser console
- [ ] No error messages in application logs
- [ ] Database connection is stable
- [ ] All services are running
- [ ] API endpoints responding
- [ ] Mobile app works
- [ ] Performance is acceptable

---

**Last Updated:** October 7, 2026  
**Version:** 1.0.0  
**Maintained By:** Support Team
