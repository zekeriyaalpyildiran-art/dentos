# 👥 DentOS Staff Onboarding Guide

Complete training guide for clinic staff on DentOS system.

---

## 🎯 Quick Overview

DentOS is your complete dental clinic management system. It helps manage:
- 📅 Appointments and schedules
- 👥 Patient profiles and records
- 💰 Treatment plans and payments
- 🎯 Leads and customer relationships
- 📦 Inventory and supplies
- 🧪 Lab orders and tracking

---

## 👨‍💼 Admin Guide

**Role:** Full system access and management  
**Responsibility:** Oversee entire clinic operations

### First Day Checklist

- [ ] Access `/admin/users` to view staff directory
- [ ] Configure clinic details in `/admin/settings`
- [ ] Set up integrations (SMS, Payments, e-Arşiv)
- [ ] Review upcoming appointments
- [ ] Check system status

### Main Responsibilities

**User Management**
- Create and manage staff accounts
- Assign roles (Doctor, Receptionist)
- Monitor user activity
- Update specializations

**System Configuration**
1. **Clinic Settings** (`/admin/settings`)
   - Update clinic name and contact info
   - Set working hours (default: 09:00-18:00)
   - Configure appointment duration (default: 30 min)
   - Set cancellation window (default: 24 hours)

2. **Integrations**
   - SMS Gateway (Netgsm) - for appointment reminders
   - Payment Processor (Iyzico) - for online payments
   - e-Arşiv (Tax System) - for invoicing
   - e-Nabız (Health System) - for patient records

3. **Notifications**
   - Enable/disable SMS reminders
   - Enable/disable email reminders
   - Configure push notifications
   - Set reminder timing (1/24/48 hours before)

**Monitoring**
- Dashboard overview of key metrics
- User activity logs
- System health status
- Compliance reports

### Key Pages

| Page | URL | Purpose |
|------|-----|---------|
| Dashboard | `/dashboard` | System overview |
| Users | `/admin/users` | Staff management |
| Settings | `/admin/settings` | Configuration |
| Appointments | `/appointments` | Schedule overview |
| CRM | `/crm/kanban` | Lead management |
| Reports | `/reports` | Compliance & analytics |

---

## 👨‍⚕️ Doctor Guide

**Role:** Patient treatment and appointment management  
**Responsibility:** Provide clinical care and manage patient treatment

### First Day Checklist

- [ ] Review today's appointments (`/appointments`)
- [ ] Check patient list (`/patients`)
- [ ] View active treatment plans
- [ ] Create treatment plan for new patient
- [ ] Review lab orders

### Daily Workflow

**Morning:**
1. Open dashboard - see today's schedule
2. Review patient notes from previous appointments
3. Prepare for procedures

**During Day:**
1. Check in patients in appointments
2. Create/update treatment plans as needed
3. Write clinical notes
4. Order lab work if needed

**End of Day:**
1. Complete pending paperwork
2. Review tomorrow's schedule
3. Follow up on pending treatments

### Key Pages

| Page | Purpose |
|------|---------|
| `/dashboard` | Day overview |
| `/appointments` | Schedule and patient info |
| `/patients` | Patient profiles and history |
| `/treatment-plans` | Create and track plans |
| `/lab` | Lab orders and tracking |

### Treatment Plans

**Creating a Plan:**
1. Select patient
2. Add procedures (Cleaning, Filling, Crown, etc.)
3. System calculates total cost
4. Patient selects payment (1/3/6/12 months)
5. Send to patient for review

**Pricing:**
- Diş Temizliği: ₺500 (30 min)
- Dolgu: ₺1,200 (45 min)
- Kuron: ₺3,500 (90 min)
- Custom procedures available

---

## 👩‍💼 Receptionist Guide

**Role:** Patient scheduling and front desk  
**Responsibility:** Manage appointments and patient communication

### First Day Checklist

- [ ] Learn appointment system
- [ ] Review today's schedule
- [ ] Practice patient check-in
- [ ] Learn how to send reminders
- [ ] Understand cancellation policies

### Daily Tasks

**Opening (09:00):**
1. Check dashboard for today's appointments
2. Prepare patient files
3. Confirm morning appointments (via SMS/call)

**During Day:**
1. Answer phones and schedule appointments
2. Check in arriving patients
3. Send SMS reminders (24h before)
4. Handle cancellations/rescheduling
5. Process payments

**Before Closing (18:00):**
1. Confirm tomorrow's first appointments
2. Update patient contact info if needed
3. Prepare files for tomorrow

### Appointment Rules

**Scheduling:**
- Check doctor availability
- Book appropriate time slot
- Note any special requirements
- Send confirmation SMS/email

**Cancellation Policy:**
- 24+ hours: Free cancellation
- Less than 24 hours: Full charge
- No-show: Full charge

**Conflicts:**
- System prevents double-booking
- Automatic error if timing overlaps
- Suggest alternative time

### Patient Communication

**SMS Reminders (Template):**
```
"Randevu hatırlatması: Yarın 09:30'de Dr. Ece ile görüşmeniz var. 
Iptal/Yeniden Planla: +90 555 100-0001"
```

**Professional Tone:**
- Always be polite and professional
- Use patient's name when possible
- Confirm details before booking
- Handle complaints with empathy

### Key Pages

| Page | Purpose |
|------|---------|
| `/dashboard` | Quick overview |
| `/appointments` | Schedule management |
| `/patients` | Patient info lookup |
| `/treatment-plans` | View patient plans |

---

## 📚 Common Tasks

### Task 1: Schedule Appointment

**Steps:**
1. Open `/appointments` → "Yeni Randevu Ekle"
2. Select patient (or create new)
3. Choose doctor
4. Pick date and time
5. Select procedure type
6. Add notes if needed
7. Send confirmation

### Task 2: Create Treatment Plan

**Steps:**
1. Open `/treatment-plans` → "Yeni Plan"
2. Select patient
3. Add procedures (click to add)
4. Confirm total cost
5. Show patient payment options
6. Send for approval

### Task 3: Send Reminder SMS

**Steps:**
1. Open `/appointments`
2. Click appointment
3. Click "SMS Gönder" (Send SMS)
4. Confirm phone number
5. System sends automatically

### Task 4: Process Payment

**Steps:**
1. Open patient profile
2. View treatment plan
3. Click "Ödeme Yap" (Make Payment)
4. Enter amount and card details
5. Confirm transaction
6. Print receipt

### Task 5: Create Patient Profile

**Steps:**
1. Open `/patients` → "Yeni Hasta"
2. Enter basic info:
   - Name, phone, email
   - Birth date, gender
   - Address
3. Get KVKK consent signature
4. Save profile
5. System creates patient record

---

## 🎓 System Features Explained

### Dashboard

Shows different information based on your role:

**Admin sees:**
- Total users, patients, revenue
- System alerts
- Recent activity

**Doctor sees:**
- Today's appointments
- Patient workload
- Pending treatment plans

**Receptionist sees:**
- Today's schedule
- Cancellations/reschedules needed
- Patient phone numbers

### CRM Kanban Board

Lead management with 6 stages:
1. 🆕 **Yeni** - New leads
2. ☎️ **İletişime Geçildi** - Contacted
3. ⭐ **İlgilendiği** - Interested
4. ✅ **Nitelikli** - Qualified
5. 🎯 **Müşteri** - Customer
6. ❌ **Kaybedildi** - Lost

**How to use:**
- Drag lead cards between columns
- Click card to see full details
- Add notes and follow-ups
- Track conversion funnel

### Inventory System

Track supplies and materials:
- Stock levels for each item
- Automatic low-stock alerts
- Expiry date reminders
- Purchase history

**When stock is low:**
- System highlights in red
- Suggests reordering
- Tracks supplier prices
- Logs purchase dates

### Lab Orders

Submit work to dental labs:
1. Select patient and teeth
2. Choose material and shade
3. Add special instructions
4. Specify delivery date
5. Lab receives and tracks order

---

## ⚠️ Important Policies

### KVKK (Turkish GDPR) Compliance

**What we protect:**
- Patient personal data
- Medical records
- Payment information
- Contact details

**Your responsibility:**
- Don't share patient data without consent
- Keep passwords confidential
- Lock computer when away
- Report suspicious activity

### Appointment Cancellation

**24+ hours before:**
- Free cancellation
- No charge to patient

**Less than 24 hours:**
- Full appointment charge applies
- Doctor may waive at discretion

**No-show:**
- Automatic full charge
- Document in patient record
- Contact to confirm future appointments

### Payments

**Accepted Methods:**
- Credit card (Visa, Mastercard)
- Debit card
- Cash (receptionist only)
- Installments (1/3/6/12 months)

**Processing:**
- Verify patient identity
- Confirm amount
- Process securely
- Print receipt

### Confidentiality

**Never:**
- Discuss patient details in public
- Leave patient files visible
- Share contact information
- Gossip about treatments

**Always:**
- Lock computer when away
- Use secure passwords
- Report breaches immediately
- Follow clinic policies

---

## 🆘 Troubleshooting

### "Cannot access system"
1. Check internet connection
2. Clear browser cache
3. Try different browser
4. Contact admin

### "Patient not found"
1. Check spelling of name
2. Try phone number search
3. Verify spelling in system
4. Ask patient for email

### "Cannot send SMS"
1. Verify phone number format
2. Check Netgsm credit
3. Confirm SMS enabled in settings
4. Try email alternative

### "Payment failed"
1. Ask for different card
2. Check card expiry date
3. Verify correct amount
4. Check Iyzico connection

---

## 📞 Support

**For help:**
- Ask your admin colleague
- Check this guide
- Review dashboard help
- Contact clinic management

**Emergency issues:**
- System down? Contact IT
- Patient urgent? Call doctor
- Payment problem? Contact admin

---

## 🎉 Welcome!

You're now ready to use DentOS. Key things to remember:

1. **Admin:** Focus on setup and oversight
2. **Doctor:** Concentrate on patient care
3. **Receptionist:** Keep schedule running smoothly

Questions? Ask your manager or the admin team.

---

**Version:** 1.0.0  
**Last Updated:** October 7, 2026  
**Questions?** Contact clinic management
