# 🔌 DentOS API Documentation

Complete REST API reference for DentOS system integrations and extensions.

---

## 🚀 Base URL

```
Production: https://dentos.example.com/api
Development: http://localhost:3000/api
```

---

## 🔐 Authentication

All API endpoints require authentication via JWT token in the `Authorization` header:

```bash
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  http://localhost:3000/api/appointments
```

### Getting a Token

Authenticate via Supabase:

```bash
curl -X POST https://knzrcgqpzjbajfboqlhq.supabase.co/auth/v1/token \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "password"
  }'
```

---

## 📋 Endpoints

### Health & System

#### GET `/health`
System health check

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-10-07T12:00:00Z"
}
```

#### GET `/health/db`
Database connection check

**Response:**
```json
{
  "database": "connected",
  "latency_ms": 45
}
```

#### GET `/test-connection`
Supabase connection test page (UI)

---

### Initialization & Seed Data

#### POST `/seed`
Load demo/test data into database

**Response:**
```json
{
  "success": true,
  "message": "Database seeding complete",
  "details": {
    "clinic": "11111111-1111-1111-1111-111111111111",
    "users": 3,
    "patients": 3,
    "procedures": 3,
    "appointments": 1
  }
}
```

**Test Data Loaded:**
- 1 clinic (Klinik Merkezi)
- 3 users: 1 admin + 2 doctors
- 3 patients with complete profiles
- 3 procedure definitions
- 1 sample appointment

---

### Patients

#### GET `/patients`
List all patients for clinic

**Query Parameters:**
- `limit` - Number of results (default: 50)
- `offset` - Pagination offset (default: 0)
- `search` - Search by name or email

**Response:**
```json
{
  "data": [
    {
      "id": "55555555-5555-5555-5555-555555555555",
      "clinic_id": "11111111-1111-1111-1111-111111111111",
      "full_name": "Ahmet Yılmaz",
      "email": "ahmet@example.com",
      "phone": "+90 555 123-4567",
      "birth_date": "1985-03-15",
      "gender": "M",
      "identity_number": "12345678901",
      "address": "İstanbul, Türkiye",
      "kvkk_consent": true,
      "kvkk_consent_date": "2026-09-01T00:00:00Z"
    }
  ],
  "total": 150,
  "limit": 50,
  "offset": 0
}
```

#### GET `/patients/:id`
Get patient details

**Response:**
```json
{
  "id": "55555555-5555-5555-5555-555555555555",
  "full_name": "Ahmet Yılmaz",
  "email": "ahmet@example.com",
  "phone": "+90 555 123-4567",
  "medical_history": [
    {
      "date": "2026-09-05",
      "procedure": "Diş Temizliği",
      "notes": "Rutin kontrol yapıldı"
    }
  ],
  "active_treatment_plans": 2
}
```

#### POST `/patients`
Create new patient

**Request Body:**
```json
{
  "full_name": "Yeni Hasta",
  "email": "yeni@example.com",
  "phone": "+90 555 000-0000",
  "birth_date": "1990-01-01",
  "gender": "F",
  "address": "İzmir, Türkiye",
  "kvkk_consent": true
}
```

**Response:** Created patient object with ID

---

### Appointments

#### GET `/appointments`
List appointments

**Query Parameters:**
- `date_from` - Start date (ISO 8601)
- `date_to` - End date (ISO 8601)
- `status` - Filter by status (scheduled, completed, cancelled)
- `doctor_id` - Filter by doctor
- `patient_id` - Filter by patient

**Response:**
```json
{
  "data": [
    {
      "id": "app-123",
      "patient_id": "55555555-5555-5555-5555-555555555555",
      "doctor_id": "33333333-3333-3333-3333-333333333333",
      "appointment_date": "2026-10-08",
      "start_time": "09:30",
      "end_time": "10:00",
      "status": "scheduled",
      "procedure": "Diş Temizliği",
      "chair_number": 2,
      "notes": "Rutin kontrol"
    }
  ],
  "total": 25
}
```

#### POST `/appointments`
Create appointment

**Request Body:**
```json
{
  "patient_id": "55555555-5555-5555-5555-555555555555",
  "doctor_id": "33333333-3333-3333-3333-333333333333",
  "appointment_date": "2026-10-08",
  "start_time": "09:30",
  "end_time": "10:00",
  "procedure_id": "PROC-001",
  "notes": "Regular checkup"
}
```

**Validation:**
- Checks for time conflicts
- Validates doctor availability
- Verifies patient exists
- Confirms procedure duration matches slot

---

### Treatment Plans

#### GET `/treatment-plans/:patient_id`
Get patient's treatment plans

**Response:**
```json
{
  "data": [
    {
      "id": "tp-456",
      "patient_id": "55555555-5555-5555-5555-555555555555",
      "total_amount": 5000,
      "status": "in_progress",
      "items": [
        {
          "procedure": "Dolgu",
          "amount": 1200,
          "quantity": 2
        },
        {
          "procedure": "Kuron",
          "amount": 3500,
          "quantity": 1
        }
      ],
      "payment_status": "partially_paid",
      "installment_plan": "6 months",
      "created_at": "2026-09-15"
    }
  ]
}
```

#### POST `/treatment-plans`
Create treatment plan

**Request Body:**
```json
{
  "patient_id": "55555555-5555-5555-5555-555555555555",
  "items": [
    {
      "procedure_id": "PROC-002",
      "quantity": 2
    },
    {
      "procedure_id": "PROC-003",
      "quantity": 1
    }
  ],
  "installment_months": 6
}
```

---

### Payments

#### GET `/payments/history/:patient_id`
Get patient payment history

**Response:**
```json
{
  "data": [
    {
      "id": "pay-789",
      "amount": 2000,
      "currency": "TRY",
      "date": "2026-09-20",
      "method": "credit_card",
      "status": "completed",
      "treatment_plan_id": "tp-456"
    }
  ],
  "total_paid": 2000,
  "outstanding": 3000
}
```

#### POST `/payments/process`
Process payment via Iyzico (demo mode)

**Request Body:**
```json
{
  "patient_id": "55555555-5555-5555-5555-555555555555",
  "treatment_plan_id": "tp-456",
  "amount": 1000,
  "card_number": "5555555555554444",
  "exp_month": 12,
  "exp_year": 2028,
  "cvv": "123",
  "card_holder": "Ahmet Yilmaz"
}
```

**Response:**
```json
{
  "success": true,
  "transaction_id": "iyzico_12345",
  "amount": 1000,
  "status": "completed",
  "message": "Ödeme başarıyla işlendi"
}
```

---

### CRM & Leads

#### GET `/crm/leads`
List all leads

**Query Parameters:**
- `stage` - Filter by stage (1-6)
- `search` - Search by name/company

**Response:**
```json
{
  "data": [
    {
      "id": "lead-001",
      "name": "Acme Company",
      "contact_name": "John Doe",
      "email": "john@acme.com",
      "phone": "+90 555 999-8888",
      "stage_id": 3,
      "stage_name": "İlgilendiği",
      "budget": 50000,
      "lead_type": "Corporate",
      "notes": "Large clinic interested in monthly plans"
    }
  ],
  "total": 42,
  "stages": [
    { "id": 1, "name": "Yeni" },
    { "id": 2, "name": "İletişime Geçildi" },
    { "id": 3, "name": "İlgilendiği" },
    { "id": 4, "name": "Nitelikli" },
    { "id": 5, "name": "Müşteri" },
    { "id": 6, "name": "Kaybedildi" }
  ]
}
```

#### PUT `/crm/leads/:id/stage`
Move lead to different stage

**Request Body:**
```json
{
  "stage_id": 4,
  "notes": "Client qualified for enterprise plan"
}
```

---

### Inventory

#### GET `/inventory`
List inventory items

**Query Parameters:**
- `low_stock` - Show only low-stock items (true/false)
- `category` - Filter by category

**Response:**
```json
{
  "data": [
    {
      "id": "inv-001",
      "name": "Composite Fillings (Shade A1)",
      "category": "Restorative",
      "quantity": 15,
      "reorder_level": 20,
      "unit_price": 250,
      "expiry_date": "2027-12-31",
      "status": "low_stock"
    }
  ],
  "total_items": 87,
  "low_stock_count": 12
}
```

#### PUT `/inventory/:id`
Update inventory quantity

**Request Body:**
```json
{
  "quantity": 50,
  "reason": "Stock purchase",
  "date": "2026-10-07"
}
```

---

### Lab Orders

#### GET `/lab/orders`
List lab orders

**Query Parameters:**
- `status` - Filter by status
- `patient_id` - Filter by patient
- `date_from` - Date range start

**Response:**
```json
{
  "data": [
    {
      "id": "lab-001",
      "patient_id": "55555555-5555-5555-5555-555555555555",
      "patient_name": "Ahmet Yılmaz",
      "teeth": ["14", "15"],
      "material": "Ceramic",
      "status": "processing",
      "ordered_date": "2026-10-05",
      "expected_delivery": "2026-10-15",
      "notes": "High precision crown, shade A1"
    }
  ],
  "total": 8
}
```

#### POST `/lab/orders`
Create lab order

**Request Body:**
```json
{
  "patient_id": "55555555-5555-5555-5555-555555555555",
  "teeth": ["14", "15"],
  "material": "Ceramic",
  "shade": "A1",
  "expected_delivery": "2026-10-15",
  "notes": "High precision work"
}
```

---

### SMS Integration (Netgsm)

#### POST `/notifications/sms/send`
Send SMS notification

**Request Body:**
```json
{
  "phone_number": "+90 555 123-4567",
  "message": "Randevu hatırlatması: Yarın 09:30'de Dr. Ece ile toplantınız var."
}
```

**Response:**
```json
{
  "success": true,
  "message_id": "netgsm_123456",
  "status": "sent",
  "timestamp": "2026-10-07T12:00:00Z"
}
```

---

### Reports & Compliance

#### GET `/reports/earsiv`
e-Arşiv transaction logs

**Response:**
```json
{
  "data": [
    {
      "id": "ea-001",
      "transaction_id": "uuid-001",
      "invoice_number": "2026000001",
      "patient_name": "Ahmet Yılmaz",
      "amount": 1200,
      "date": "2026-10-01",
      "status": "submitted"
    }
  ],
  "total": 156
}
```

#### GET `/reports/kvkk-audit`
KVKK compliance audit log

**Response:**
```json
{
  "data": [
    {
      "id": "kvkk-001",
      "action": "patient_data_export",
      "patient_id": "55555555-5555-5555-5555-555555555555",
      "user_id": "22222222-2222-2222-2222-222222222222",
      "timestamp": "2026-10-05T14:30:00Z",
      "status": "completed"
    }
  ]
}
```

---

## 📊 Error Responses

### 400 Bad Request
```json
{
  "error": "validation_error",
  "message": "Email is required",
  "details": {
    "field": "email",
    "reason": "required"
  }
}
```

### 401 Unauthorized
```json
{
  "error": "unauthorized",
  "message": "Missing or invalid JWT token"
}
```

### 403 Forbidden
```json
{
  "error": "forbidden",
  "message": "You do not have permission to access this resource"
}
```

### 404 Not Found
```json
{
  "error": "not_found",
  "message": "Patient not found"
}
```

### 500 Server Error
```json
{
  "error": "server_error",
  "message": "An unexpected error occurred"
}
```

---

## 🔄 Rate Limiting

API enforces rate limits per user:
- **Limit:** 1000 requests per hour
- **Headers:** 
  - `X-RateLimit-Limit: 1000`
  - `X-RateLimit-Remaining: 999`
  - `X-RateLimit-Reset: 1633600000`

---

## 📝 Pagination

List endpoints support pagination:

```bash
GET /appointments?limit=50&offset=0
```

**Response includes:**
```json
{
  "data": [...],
  "total": 150,
  "limit": 50,
  "offset": 0,
  "has_more": true
}
```

---

## 🔐 CORS

API supports CORS for browser clients:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, DELETE
Access-Control-Allow-Headers: Content-Type, Authorization
```

---

## 📚 SDKs & Libraries

### JavaScript/TypeScript
```bash
npm install @dentos/sdk
```

```typescript
import { DentosAPI } from '@dentos/sdk';

const api = new DentosAPI({
  baseUrl: 'http://localhost:3000/api',
  token: 'your_jwt_token'
});

const patients = await api.patients.list();
```

---

## 🧪 Testing

### Using cURL

```bash
# Get appointments
curl -H "Authorization: Bearer TOKEN" \
  http://localhost:3000/api/appointments

# Create patient
curl -X POST http://localhost:3000/api/patients \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "full_name": "Test Patient",
    "email": "test@example.com",
    "phone": "+90 555 000-0000"
  }'

# Send SMS
curl -X POST http://localhost:3000/api/notifications/sms/send \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "phone_number": "+90 555 123-4567",
    "message": "Test message"
  }'
```

---

## 🔗 Related

- [README.md](./README.md) - Project overview
- [QUICK_REFERENCE.md](./QUICK_REFERENCE.md) - Developer cheat sheet
- [DEPLOYMENT.md](./DEPLOYMENT.md) - Deployment guide

---

**Last Updated:** October 7, 2026  
**Version:** 1.0.0
