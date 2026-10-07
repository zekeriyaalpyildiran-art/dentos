# 🔐 DentOS Security Hardening Guide

Comprehensive security documentation for DentOS deployment and operations.

---

## 🎯 Security Overview

DentOS implements **defense-in-depth** security architecture with multiple layers:

1. **Authentication** - Secure user login via JWT + OTP
2. **Authorization** - Role-based access control (RBAC)
3. **Data Protection** - Encryption at rest and in transit
4. **Compliance** - KVKK (Turkish GDPR) and healthcare standards
5. **Monitoring** - Audit logs and security alerts
6. **Infrastructure** - Secure network, isolation, backups

---

## 🔑 Authentication Security

### JWT Token Security

**Configuration:**
```typescript
// apps/web/src/lib/auth.ts
const JWT_EXPIRY = '24h';
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_EXPIRY = '7d';
```

**Best Practices:**
- ✅ Use strong JWT secret (32+ random characters)
- ✅ Short expiry time (24 hours)
- ✅ Implement refresh token rotation
- ✅ Store tokens in secure, httpOnly cookies only
- ❌ Never store tokens in localStorage
- ❌ Never log tokens in error messages

### OTP (One-Time Password) Implementation

**SMS-based verification:**
```bash
# Patient login flow:
1. Patient enters phone number
2. System generates 6-digit OTP
3. OTP sent via Netgsm SMS
4. Valid for 10 minutes only
5. Maximum 3 attempt retries
```

**Security rules:**
- OTP expires after 10 minutes
- Each OTP can only be used once
- 3-attempt limit before account lockout (30 min)
- OTP never sent via email (SMS only)
- Backend validates OTP server-side

### Password Management

**For admin/staff accounts:**
```
Password Requirements:
- Minimum 12 characters
- Mix of uppercase, lowercase, numbers, symbols
- No dictionary words
- No phone numbers or dates
- Must change every 90 days
- Cannot reuse last 5 passwords
```

**Reset flow:**
1. User initiates password reset
2. Email link sent (valid 1 hour)
3. New password set securely
4. Old sessions invalidated
5. Audit logged

---

## 🛡️ Authorization & Access Control

### Role-Based Access Control (RBAC)

**Three roles with strict permissions:**

#### Admin Role
```
✅ Can: Manage users, configure settings, view all data, access reports
❌ Cannot: Access patient medical data (separate permission required)
```

**Admin pages:**
- `/admin/users` - Staff management
- `/admin/settings` - System configuration
- `/admin/reports` - Compliance reports

#### Doctor Role
```
✅ Can: View assigned patients, create treatment plans, write notes
❌ Cannot: Manage users, configure system, access other clinic data
```

**Doctor pages:**
- `/dashboard` - Patient appointments
- `/patients` - Assigned patient list
- `/treatment-plans` - Create and manage
- `/lab` - Lab order management

#### Receptionist Role
```
✅ Can: Schedule appointments, update patient contact, process payments
❌ Cannot: View medical records, manage staff, configure system
```

**Receptionist pages:**
- `/appointments` - Schedule management
- `/patients` - Contact info only
- `/payments` - Payment processing

### Database Row-Level Security (RLS)

**Supabase RLS policies enforce access:**

```sql
-- Patients table: Only clinic staff can see clinic's patients
CREATE POLICY "clinic_isolation"
ON patients FOR SELECT
USING (clinic_id = (SELECT clinic_id FROM auth.users));

-- Appointments: Staff can only see own clinic appointments
CREATE POLICY "clinic_appointments"
ON appointments FOR SELECT
USING (clinic_id = (SELECT clinic_id FROM auth.users));

-- Notes: Doctors can only see own notes
CREATE POLICY "doctor_notes"
ON treatment_notes FOR SELECT
USING (
  doctor_id = auth.uid()
  OR auth.jwt()->>'role' = 'admin'
);
```

**Key principle:** Database enforces access — never trust application layer alone.

---

## 🔒 Data Protection

### Encryption in Transit

**HTTPS/TLS Configuration:**
```
✅ Required: All connections use TLS 1.2 or higher
✅ Certificate: Valid SSL/TLS certificate from trusted CA
✅ HSTS: HTTP Strict-Transport-Security enabled (1 year)
✅ Certificate pinning: Prevent man-in-the-middle attacks
```

**Headers enforced:**
```
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Content-Security-Policy: default-src 'self'
```

### Encryption at Rest

**Database encryption:**
```
- Supabase PostgreSQL: Encrypted by default
- Column-level encryption for sensitive data:
  - SSN/ID numbers
  - Treatment notes (optional)
  - Payment card hashes
```

**Backup encryption:**
```bash
# Encrypted database backups
pg_dump --format=custom | gpg --symmetric --cipher-algo AES256

# Backups stored in S3 with encryption
aws s3 sync dentos-backup/ s3://dentos-backups/ \
  --sse AES256 \
  --storage-class GLACIER
```

### Sensitive Data Handling

**Never log or expose:**
- Patient SSN/ID numbers
- Payment card details
- JWT tokens
- OTP codes
- Personal medical information

**Safe logging:**
```typescript
// ❌ Wrong
console.log(`User login: ${patient.ssn}`);

// ✅ Correct
console.log(`User login: ${patient.id}`);
```

---

## 🇹🇷 KVKK (Turkish GDPR) Compliance

### Data Collection Consent

**Required before storing any patient data:**
```
☑ Patient explicitly consents to data processing
☑ Purpose clearly stated (appointment management, treatment)
☑ Data handling practices explained
☑ Patient rights explained (access, correction, deletion)
☑ Signature or digital consent recorded
☑ Consent date logged
```

**Consent form in app:**
- Patient must check KVKK agreement
- Cannot proceed without consent
- Consent logged with timestamp
- Can be revoked anytime

### Patient Data Rights

**Patients can request:**

1. **Data Export** - All their data in portable format
   - Accessed: Profile → Privacy → Download My Data
   - Response time: 30 days
   - Format: JSON/CSV

2. **Data Correction** - Fix inaccurate information
   - Can update: Name, contact, address
   - Doctor notes: Request correction
   - Audit trail kept

3. **Data Deletion** - Right to be forgotten
   - Personal data deleted
   - Medical records: Kept per healthcare regulations
   - Audit trail: Retained for compliance

4. **Access Log** - See who accessed their data
   - View: Profile → Privacy → Access Log
   - Shows: Who, when, what accessed
   - Real-time updates

### Audit Trail

**Every access to patient data logged:**

```typescript
// Log all patient data access
async function logPatientAccess(patientId, userId, action) {
  await auditLog.create({
    patient_id: patientId,
    user_id: userId,
    action: action, // 'view', 'edit', 'delete', 'export'
    timestamp: new Date(),
    ip_address: req.ip,
    user_agent: req.headers['user-agent']
  });
}

// Accessible to admins: /admin/reports/kvkk-audit
```

---

## 🚨 Threat Prevention

### SQL Injection Prevention

**Using Drizzle ORM (safe by default):**
```typescript
// ✅ Safe - Parameterized queries
const patients = await db
  .select()
  .from(patients)
  .where(eq(patients.clinic_id, clinicId));

// ❌ Never use string concatenation
const query = `SELECT * FROM patients WHERE clinic_id = '${clinicId}'`;
```

### Cross-Site Scripting (XSS) Prevention

**Next.js automatic protections:**
- ✅ Built-in HTML escaping
- ✅ React prevents script injection in JSX
- ✅ CSP headers prevent inline scripts
- ✅ Sanitize user input before rendering

```typescript
// ✅ Safe - React escapes automatically
<p>{patientNotes}</p>

// ❌ Dangerous - Never use dangerouslySetInnerHTML
<p dangerouslySetInnerHTML={{ __html: patientNotes }} />
```

### Cross-Site Request Forgery (CSRF) Prevention

**Implemented via:**
- ✅ SameSite cookies: Strict mode
- ✅ CSRF tokens on forms
- ✅ JWT in Authorization header (not cookies)

```typescript
// Cookies configured
Set-Cookie: jwt=token; SameSite=Strict; HttpOnly; Secure
```

### Brute Force Protection

**Rate limiting on sensitive endpoints:**

```typescript
// Login endpoint - max 5 attempts per 15 minutes
app.post('/api/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many login attempts, try again later'
}));

// OTP verification - max 3 attempts
app.post('/api/auth/verify-otp', rateLimit({
  windowMs: 30 * 60 * 1000,
  max: 3,
  message: 'Too many verification attempts'
}));

// API endpoints - max 1000 per hour
app.use('/api/', rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 1000
}));
```

### Account Lockout

**After failed login attempts:**
```
5+ failed attempts → Account locked 30 minutes
Admin can manually unlock immediately
Email notification sent to account owner
```

---

## 🔍 Monitoring & Detection

### Security Logging

**Events logged:**
- ✅ All user logins (success/failure)
- ✅ Password changes
- ✅ User permission changes
- ✅ Data access (read/write/delete)
- ✅ Configuration changes
- ✅ API errors and exceptions
- ✅ Unusual patterns (mass downloads, bulk deletes)

**Log retention:**
- Production: 1 year minimum
- Test/Dev: 30 days
- Access logs: Encrypted storage
- Immutable audit trail

### Intrusion Detection

**Alerts triggered for:**

```
🚨 10+ failed logins in 5 minutes → Block IP temporarily
🚨 API rate limit exceeded → Throttle requests
🚨 Bulk data download → Admin notification
🚨 Multiple access from different IPs → Flag account
🚨 SQL error patterns → Log and investigate
🚨 File upload anomalies → Quarantine and scan
🚨 Configuration tampering → Immediate alert
```

### Vulnerability Scanning

**Automated checks:**

```bash
# Weekly dependency audit
npm audit --audit-level=moderate

# Monthly security scanning
npm install -g snyk
snyk test

# Container scanning
docker scan dentos:latest

# Code scanning (GitHub)
gh code-scanning upload
```

---

## 🛠️ Infrastructure Security

### Database Security

**Supabase configuration:**
```
✅ RLS policies: Enabled and enforced
✅ Network: Private VPC (not publicly accessible)
✅ Backups: Automated daily, encrypted
✅ Connection: SSL only (no plain TCP)
✅ Password: Strong, rotated every 90 days
✅ Monitoring: Real-time alerts for anomalies
```

### API Security

**Reverse proxy (Nginx):**
```nginx
# Block unknown hosts
server {
  server_name dentos.example.com;
  return 444;
}

# Rate limiting
limit_req_zone $binary_remote_addr zone=api:10m rate=100r/s;

# WAF rules
location / {
  if ($http_user_agent ~* (bot|scanner|crawler)) {
    return 403;
  }
  proxy_pass http://backend;
}
```

### Container Security

**Docker hardening:**
```dockerfile
# Run as non-root
USER appuser

# Read-only filesystem
RUN chmod a-w /app

# No unnecessary packages
RUN apt-get purge -y --auto-remove -o APT::AutoRemove::SuggestsImportant=false

# Security scanning
HEALTHCHECK CMD curl -f http://localhost:3000/health || exit 1
```

---

## 🔄 Backup & Disaster Recovery

### Backup Strategy

**3-2-1 Backup Rule:**
```
3 copies of data:
  1. Primary database (Supabase)
  2. Daily backup (S3)
  3. Weekly archive (Glacier)

2 different storage types:
  1. Database (Supabase)
  2. Object storage (AWS S3)

1 offsite location:
  → AWS Glacier (different region)
```

### Backup Encryption

```bash
# Database backup (automatic)
Supabase: Encrypted with clinic-specific key

# S3 backup
aws s3 sync db-backup s3://dentos-backups/ \
  --sse aws:kms \
  --sse-kms-key-id arn:aws:kms:...

# Glacier archive
aws glacier upload-archive \
  --vault-name dentos-backup \
  --body backup.tar.gz.gpg
```

### Recovery Time Objectives (RTO)

| Component | RTO | Procedure |
|-----------|-----|-----------|
| Database | 1 hour | Restore from S3 backup |
| Web app | 15 min | Redeploy from docker image |
| All data | 24 hours | Restore from Glacier |

---

## 🔑 Secrets Management

### Environment Variables

**Secure configuration:**

```bash
# .env.local (NEVER commit)
DATABASE_URL=postgresql://...
SUPABASE_URL=https://...
SUPABASE_KEY=...
JWT_SECRET=... (32+ random chars)
NEXTAUTH_SECRET=...
NETGSM_API_KEY=...
IYZICO_API_KEY=...
```

**In production:**
- Use environment variables from hosting provider
- Rotate keys every 90 days
- Store in secure vault (AWS Secrets Manager, etc.)
- Never log secret values

### Key Rotation

**Schedule:**
```
Every 90 days:
- JWT secret → Generate new, update in app, old sessions still valid
- Database password → Change in Supabase console
- API keys (Netgsm, Iyzico) → Rotate with provider
- SSL certificates → Auto-renewed (Let's Encrypt)
```

---

## 📋 Security Checklist

### Before Production Deployment

- [ ] All dependencies updated (`npm audit`)
- [ ] Environment variables configured securely
- [ ] SSL/TLS certificate installed
- [ ] Database backups tested
- [ ] Firewall rules configured
- [ ] Rate limiting enabled
- [ ] HTTPS redirect active
- [ ] Security headers present
- [ ] Audit logging functional
- [ ] User authentication tested
- [ ] RLS policies verified
- [ ] Data encryption confirmed
- [ ] Disaster recovery plan tested
- [ ] Security training completed
- [ ] Incident response plan ready

### Monthly Security Review

- [ ] Check dependency vulnerabilities
- [ ] Review access logs for anomalies
- [ ] Verify backup integrity
- [ ] Test disaster recovery
- [ ] Review user permissions
- [ ] Check data retention policies
- [ ] Audit configuration changes
- [ ] Review failed login attempts

### Quarterly Security Audit

- [ ] Full vulnerability scan
- [ ] Penetration testing
- [ ] Code security review
- [ ] Compliance audit (KVKK)
- [ ] Policy updates
- [ ] Staff training refresh
- [ ] Incident review
- [ ] Disaster recovery drill

---

## 🚨 Incident Response

### If Breach Suspected

**Immediate actions (within 1 hour):**

```bash
1. STOP normal operations
2. Isolate affected systems
3. Enable emergency logging
4. Notify security team
5. Document timeline and evidence
6. Do NOT delete logs

7. Preserve evidence
   - Take memory dumps
   - Backup affected databases
   - Screenshot error messages
   - Note suspicious activities
```

### Notification Requirements (KVKK)

**Within 72 hours of discovering breach:**

```
❑ Notify Turkish Data Protection Authority (KVKK)
❑ Notify affected patients
❑ Document: What, When, Who, Impact, Response
❑ Provide: Credit monitoring if needed
❑ Public statement: Acknowledge and explain
```

### Post-Incident

```
Within 7 days:
- [ ] Complete incident report
- [ ] Root cause analysis
- [ ] Security improvements identified
- [ ] Staff retrained
- [ ] Customers notified of fixes

Within 30 days:
- [ ] All fixes implemented
- [ ] Security audit completed
- [ ] Enhanced monitoring deployed
```

---

## 📚 Security Resources

### Internal Documentation
- [KVKK Compliance Guide](./ONBOARDING.md#important-policies)
- [API Security](./API.md#authentication)
- [Database Schema](./FEATURES.md)

### External Resources
- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [NIST Cybersecurity Framework](https://www.nist.gov/cyberframework)
- [KVKK Official Site](https://www.kvkk.gov.tr/)
- [Turkish Healthcare Standards](https://www.saglik.gov.tr/)

### Tools & Services
- **Dependency Audit:** `npm audit`, Snyk
- **Container Scanning:** Docker Scout, Trivy
- **Secret Management:** 1Password, HashiCorp Vault
- **Penetration Testing:** Burp Suite, OWASP ZAP
- **Monitoring:** Sentry, LogRocket, Datadog

---

## ✅ Compliance Statements

### KVKK (Turkish GDPR)

✅ **Personal Data Protection Act Compliance**
- Legal basis: Contractual necessity + explicit consent
- Processing purpose: Appointment/treatment management
- Data retention: Per healthcare regulations (10 years)
- Data subject rights: Fully implemented
- Privacy notice: Available in Turkish and English
- Audit trail: Complete and immutable

### Healthcare Standards

✅ **Patient Privacy & Confidentiality**
- Medical records: Encrypted and access-controlled
- Confidentiality: Enforced via RLS and audit logs
- Retention: Compliant with Turkish health ministry
- International: GDPR-compliant for EU patients

✅ **Data Security Standards**
- Encryption: AES-256 at rest, TLS 1.2+ in transit
- Access control: Role-based with database enforcement
- Monitoring: Real-time audit logging
- Incident response: 72-hour notification protocol

---

## 📞 Security Contact

**Reporting vulnerabilities:**
- Email: security@dentos.example.com
- Do NOT create public issue
- Include: Type, location, impact, proof-of-concept
- Response time: Within 24 hours
- Disclosure: 90-day coordinated disclosure

---

**Last Updated:** October 7, 2026  
**Version:** 1.0.0  
**Classification:** Internal - Confidential
