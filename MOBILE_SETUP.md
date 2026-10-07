# 📱 DentOS Mobile App Setup Guide

Complete guide for setting up and using the DentOS patient mobile application.

---

## 🎯 Overview

The DentOS mobile app is a patient-facing application built with **React Native + Expo**. Patients can:
- 📅 View upcoming appointments
- 🗓️ Book new appointments
- 👤 Manage their profile
- 🔔 Receive push notifications
- 💳 View treatment plans

---

## 🚀 Quick Start (5 Minutes)

### For Testing/Development

**Requirements:**
- Node.js 18+
- pnpm
- Expo Go app (free, on iOS/Android app store)

**Steps:**

```bash
# 1. Clone repository
git clone https://github.com/zekeriyaalpyildiran-art/dentos.git
cd dentos

# 2. Install dependencies
pnpm install

# 3. Start mobile app
pnpm -F mobile start

# 4. Scan QR code
# Use Expo Go app to scan the QR code displayed in terminal
# Or press 'i' for iOS Simulator, 'a' for Android Emulator
```

**That's it!** The app will launch on your device or emulator.

---

## 📋 Prerequisites

### System Requirements

- **iOS:** iOS 13.0 or later
- **Android:** Android 7.0 or later
- **Storage:** 50MB free space
- **RAM:** 2GB minimum

### For Development

- Node.js 18.0 or higher
- npm or pnpm (recommended: pnpm)
- Expo CLI: `npm install -g expo-cli`
- iOS Simulator (Mac only) or Android Emulator
- Expo Go app on your phone

---

## 🔑 Authentication

### Login Flow

**Step 1:** Open mobile app  
**Step 2:** Enter phone number (+90 format)  
**Step 3:** Receive OTP via SMS  
**Step 4:** Enter OTP code  
**Step 5:** Logged in!

### Test Account

**Phone:** +90 555 123-4567  
**Note:** OTP sent via SMS in production; mock in demo mode

### Logout

1. Open app settings (gear icon)
2. Tap "Oturumu Kapat" (Logout)
3. Confirm logout

---

## 🎮 Using the App

### Main Screens

#### 📅 Appointments (Home)

**What you see:**
- Upcoming appointments list
- Doctor name and specialty
- Date, time, and location
- Appointment status
- Notes from clinic

**Actions:**
- Tap to view details
- Reschedule (24+ hours before)
- Cancel (with 24-hour notice)
- Get directions
- Call clinic

#### 🗓️ Book Appointment

**How to book:**

1. Tap "Yeni Randevu Ekle" (New Appointment)
2. Select doctor:
   - Dr. Ece Kara (Genel Diş Tedavisi)
   - Dr. Cem Aydemir (Ortodontisi)
3. Choose date from calendar
4. Select time slot (available times highlighted)
5. Confirm booking
6. Receive SMS confirmation

**Booking Rules:**
- Minimum 24 hours in advance
- Each appointment is 30 minutes
- Morning: 09:00-12:00
- Afternoon: 14:00-18:00
- Closed: 12:00-14:00 (lunch)

#### 👤 Profile

**Your Information:**
- Name and phone number
- Email address
- Birth date and gender
- Address
- KVKK consent status
- Treatment history

**Actions:**
- Update contact info
- Change password
- View KVKK status
- Download data (GDPR right)
- View privacy policy

#### 💰 Treatment Plans

**See your plans:**
- Active treatment plans
- Total cost
- Procedures included
- Payment status
- Remaining balance
- Installment schedule

**Payment:**
- Pay full amount
- Pay installment
- View payment history
- Download receipts

#### 🔔 Notifications

**You'll receive:**
- 📅 Appointment reminders (24 hours before)
- ✅ Appointment confirmations
- 💰 Payment reminders
- 📢 Clinic announcements
- 🎁 Special offers

**Manage notifications:**
- Settings → Notifications
- Toggle each type on/off
- Set reminder time (1/24/48 hours)

---

## 🛠️ Troubleshooting

### Can't Login

**Problem:** "Oturum açılamadı" (Login failed)

**Solutions:**
1. Check phone number format: +90 5XX XXX XXXX
2. Verify OTP code from SMS
3. Check internet connection
4. Try again in 5 minutes
5. Contact clinic: +90 (555) 100-0001

### Missing Appointments

**Problem:** Can't see upcoming appointments

**Solutions:**
1. Refresh app (pull down)
2. Check KVKK consent status
3. Verify clinic added you correctly
4. Contact clinic to confirm booking
5. Reinstall app if still missing

### Notifications Not Working

**Problem:** Not receiving appointment reminders

**Solutions:**
1. Check notification settings
2. Verify push notifications enabled
3. Check phone notification permissions
4. iOS: Settings → Notifications → DentOS → Allow
5. Android: Settings → Apps → DentOS → Notifications
6. Reinstall app

### Payment Issues

**Problem:** "Ödeme başarısız" (Payment failed)

**Solutions:**
1. Try different payment method
2. Check card is not expired
3. Verify card has sufficient balance
4. Call clinic: +90 (555) 100-0001
5. Visit clinic to pay in person

### App Crashes

**Problem:** App closes unexpectedly

**Solutions:**
1. Force close app: swipe up (iOS) or back button (Android)
2. Reopen app
3. Check available storage (need 50MB)
4. Update app from app store
5. Reinstall if still crashing
6. Contact clinic support

---

## 🔐 Privacy & Security

### Data Protection

**Your data is protected by:**
- KVKK (Turkish GDPR) compliance
- Encrypted communication (HTTPS)
- Secure authentication (JWT tokens)
- Row-level database security
- Regular security audits

### What We Collect

**Personal:**
- Name, phone, email
- Birth date, gender
- Address

**Medical:**
- Appointment history
- Treatment plans
- Procedures completed
- Notes from dentist

**Technical:**
- Device ID
- IP address
- App usage statistics

### Your Rights (KVKK)

You have the right to:
- 📥 Download your data
- ✏️ Correct your information
- 🗑️ Request deletion
- 📋 Know what we store
- 🚫 Opt-out of marketing

**To exercise rights:**
1. Open Profile → Privacy
2. Select "KVKK Hakları" (KVKK Rights)
3. Choose action
4. Submit request
5. Response within 30 days

---

## 📱 Features by Role

### Patient View

✅ View appointments  
✅ Book appointments  
✅ Reschedule (24+ hours)  
✅ Cancel appointment  
✅ View treatment plans  
✅ Make payments  
✅ Manage profile  
✅ Receive notifications  

❌ Cannot: Manage inventory, access reports, manage users

---

## 🔗 Integration with Web App

The mobile app is **fully integrated** with the web admin system:

- Appointments created via web show on mobile
- Treatment plans update in real-time
- Payments sync instantly
- Notifications push from web actions
- Profile changes sync both ways

**No manual sync needed** — everything is automatic!

---

## 🆘 Support

### Common Questions

**Q: How do I reset my password?**  
A: Open login screen → "Şifremi Unuttum" → Enter phone → Follow SMS

**Q: Can I see past appointments?**  
A: Yes, swipe left in appointments list for history

**Q: How do I print my treatment plan?**  
A: Tap treatment plan → Share → Select printer or PDF

**Q: Is my data safe?**  
A: Yes, KVKK compliant with encryption and security audits

**Q: Can I use the app offline?**  
A: No, internet required. View cached data only.

### Contact Clinic

**By Phone:** +90 (555) 100-0001  
**By Email:** info@klinikmerkezi.com.tr  
**By App:** Settings → Contact Support

---

## 📲 Installation

### For Patients (Production Release)

**iOS:**
1. Open App Store
2. Search "DentOS" or scan QR code
3. Tap "Get"
4. Authenticate with Face ID/Touch ID
5. Wait for installation
6. Tap "Open"

**Android:**
1. Open Google Play Store
2. Search "DentOS" or scan QR code
3. Tap "Install"
4. Grant permissions
5. Wait for installation
6. Tap "Open"

### For Testers (Development)

```bash
# Using Expo Go (easiest)
expo start
# Scan QR code with Expo Go app

# Using iOS Simulator
expo start
# Press 'i'

# Using Android Emulator
expo start
# Press 'a'
```

---

## 🔄 Updates

The app updates automatically:

- **iOS:** Through App Store
- **Android:** Through Google Play Store
- **Development:** New Expo Go session starts latest

**Manual Update Check:**
1. Open settings
2. Look for "Güncelleme Kontrol Et" (Check for Updates)
3. Install if available

---

## 📚 Development Documentation

### Building from Source

```bash
# Install dependencies
cd apps/mobile
pnpm install

# Start development server
pnpm start

# Build for iOS
eas build --platform ios

# Build for Android
eas build --platform android

# Submit to stores
eas submit --platform ios
eas submit --platform android
```

### Tech Stack

- **Framework:** React Native + Expo
- **State:** Zustand
- **API:** Supabase REST
- **Auth:** JWT + OTP
- **Notifications:** Firebase Cloud Messaging
- **UI:** React Native Paper

### Key Files

```
apps/mobile/
├── app/
│   ├── index.tsx           # Home/appointments
│   ├── book.tsx            # Booking screen
│   ├── profile.tsx         # User profile
│   ├── plans.tsx           # Treatment plans
│   └── login.tsx           # OTP login
├── store/
│   └── authStore.ts        # Auth state
└── lib/
    └── supabase.ts         # API client
```

---

## ✅ Deployment Checklist

Before releasing to app stores:

- [ ] All features tested on device
- [ ] Notifications working
- [ ] Payments tested (test cards)
- [ ] Push certificates installed
- [ ] App icon and splash screen set
- [ ] Privacy policy updated
- [ ] KVKK compliance verified
- [ ] Build signed and ready
- [ ] Release notes written
- [ ] Beta testers approved
- [ ] App Store credentials ready
- [ ] Google Play credentials ready

---

## 📖 Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | Oct 7, 2026 | Initial release |
| 0.9.0 | Sep 28, 2026 | Beta testing |
| 0.1.0 | Sep 1, 2026 | Development |

---

## 🎓 Learning Path

1. **First Use:** Install → Login → View appointments
2. **Booking:** Create new appointment
3. **Profile:** Update your information
4. **Plans:** View treatment plans
5. **Payments:** Make a payment
6. **Support:** Contact clinic if needed

---

**Welcome to DentOS Mobile! 🦷📱**

Built for patient convenience and clinic efficiency.

For questions: info@klinikmerkezi.com.tr
