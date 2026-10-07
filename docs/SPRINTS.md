# Sprint Planı
Her görev: Claude Code'a tek seferde verilir. Kabul kriterleri sağlanmadan sonraki göreve geçilmez.

## Sprint 0 — İskelet
- [x] **S0.1** Monorepo kur: pnpm, turbo, apps/web (Next 14, Tailwind, shadcn init), apps/mobile (Expo, expo-router), packages/{db,shared,i18n,ai,ui}. `pnpm dev` ikisini de ayağa kaldırır.
   - ✅ typecheck/lint geçer
   - ✅ web'de /api/health endpoint çalışır
   - ✅ mobilde Expo başlar (boş ekran)
   - ✅ Commit: `feat(s0.1): Setup monorepo with pnpm, turbo, Next.js, Expo`

- [x] **S0.2** Supabase + Drizzle + RLS. Drizzle schema (clinics, users, doctors, chairs), migration SQL, RLS politikaları, seed veri (2 clinic test).
   - ✅ Schema tanımlandı (core.ts)
   - ✅ Migration SQL çalıştırıldı Supabase'de (0001_init.sql)
   - ✅ RLS politikaları uygulandı Supabase'de (core.sql)
   - ✅ Seed veri insert edildi (2 clinic, 2 user, 2 doctor, 4 chairs)
   - ✅ Custom JWT hook dokümentasyonu
   - ✅ DATABASE_URL setup (.env.local'da)
   - 📖 Setup adımları: `/docs/S0-2-SETUP.md`

- [x] **S0.3** Auth: personel giriş (email+şifre), rol bazlı layout guard, panel iskeleti.
   - ✅ Supabase Auth client + session sync
   - ✅ Login sayfası (email + password)
   - ✅ ProtectedRoute guard (redirect to login/dashboard)
   - ✅ Zustand auth store (user + loading)
   - ✅ Sidebar navigation (9 modules)
   - ✅ Dashboard with user info + module cards
   - ✅ Placeholder pages for all modules
   - ✅ TypeScript strict mode compliance (all packages pass typecheck)
   - ⏳ Next: JWT custom claims Supabase hook setup (auth_user_id, clinic_id, role claims)

- [x] **S0.4** Seed Expansion: Demo clinics, procedures catalog, treatment chairs.
   - ✅ Procedures catalog: 40 items across 10 categories (examination→orthodontics)
   - ✅ 20 procedures per clinic covering full treatment spectrum
   - ✅ 5 new chairs added: 3 to clinic1 (7 total), 2 to clinic2 (7 total)
   - ⏳ Doctor expansion deferred to S1.1 (requires unique user accounts per doctor)
   - ⏳ Patient records deferred to S1.1 (requires dedicated patients schema)
   - ✅ All infrastructure ready for appointment scheduling (S1.3)

- [x] **S0.5** CI (GitHub Actions): typecheck, lint, test, migration drift kontrolü.
   - ✅ GitHub Actions workflow setup (ubuntu-latest, Node 20.x, pnpm 9.4.0)
   - ✅ Typecheck job: TypeScript strict mode validation
   - ✅ Lint job: ESLint quality checks
   - ✅ Migration Drift Check: Drizzle generate + git diff detection
   - ✅ Build Web job: Next.js production build
   - ✅ Test job: Unit tests (continue-on-error)
   - ✅ pnpm cache layer: Optimized CI runs
   - Runs on: push/PR to main & develop branches

## Sprint 1 — Hasta + Randevu (web)
- [ ] S1.1 patients şeması + RLS + patient_access_log; hasta listesi (arama: ad/telefon/TC-hash), hasta oluştur/düzenle formu, KVKK rıza alanı.

- [ ] S1.2 appointments + reminders + waitlist şeması; çakışma kontrolü (aynı hekim/koltuk).

- [ ] S1.3 Ajanda UI: gün/hafta görünümü, hekim ve koltuk sütunları, sürükle-bırak, durum renkleri, hızlı randevu modalı. Realtime güncelleme.

- [ ] S1.4 Hasta dosyası sayfası: özet, randevular, (boş sekmeler: plan, görüntüler, ödemeler, mesajlar).

- [ ] S1.5 notifications tablosu + cron + Netgsm SMS adaptörü (stub). Randevu oluşturulunca T-24s/T-2s kayıtları.

## Sprint 2 — Macro Göçü
- [ ] S2.1 scripts/migration iskeleti, dry-run, rapor. (Alan eşleme docs/07 dolunca)

- [ ] S2.2 Gerçek veriyle staging'e yükleme, kabul testi.

## Sprint 3 — Mobil
- [ ] S3.1 Telefon + OTP girişi (Supabase phone auth), patients.auth_user_id eşleme, hasta JWT'de patient_id claim, hasta RLS politikaları.

- [ ] S3.2 Ekranlar: Ana sayfa (yaklaşan randevu), Randevu al (hekim→tarih→saat), Randevularım (iptal/ertele), Profil.

- [ ] S3.3 Expo push kaydı, hatırlatma bildirimi, randevu sonrası bakım mesajı.

## Sprint 4 — Mesajlaşma + AI Banko + Tickets
- [ ] S4.1 conversations/messages şeması, realtime, mobil sohbet ekranı, panel inbox.

- [ ] S4.2 packages/ai: client, sanitize, araçlar (get_clinic_info, search_knowledge, slots, create/reschedule, get_my_appointments, create_ticket, handoff). ai_traces.

- [ ] S4.3 Banko akışı (docs/05): sınıflandırma → yanıt → handoff. clinic_knowledge + pgvector + panelden bilgi girişi.

- [ ] S4.4 tickets + yorumlar + SLA; mobilde şikayet formu ve durum takibi.

- [ ] S4.5 WhatsApp Cloud API webhook → aynı conversation akışı.

## Sprint 5 — Plan + Kilit + Ödeme
- [ ] S5.1 procedures_catalog yönetimi, treatment_plans + plan_items, odontogram bileşeni (FDI), plan yazma UI.

- [ ] S5.2 "Yayınla": AI ile patient_note taslağı, hekim onayı, access_level otomatik geçişler.

- [ ] S5.3 Mobil: plan görüntüleme (seviye≥2), kalem bazlı açıklama, kabul butonu.

- [ ] S5.4 payments + iyzico (online, taksit), panelde manuel tahsilat, patient_balances view, mobil ödeme ekranı.

- [ ] S5.5 AI araçları: get_price_range, get_treatment_plan.

## Sprint 6 — CRM
- [ ] S6.1 leads + lead_events, otomatik aşama geçişleri (trigger).

- [ ] S6.2 Kanban UI, filtre (kaynak/hekim/sahip), next_action hatırlatmaları, kayıp sebebi.

- [ ] S6.3 Rapor: kaynak bazlı dönüşüm hunisi, plan kabul oranı, no-show oranı.

- [ ] S6.4 CRM asistanı: "15 gündür dönüş yapmayan plan_presented listesi + mesaj taslağı" aracı.

## Sprint 7 — Lab, Stok, Görüntüler
- [ ] S7.1 labs + lab_orders, durum akışı, gecikme uyarısı (cron), mobilde seviye≥3 lab durumu.

- [ ] S7.2 stock_items/movements, plan_item done → stock_consumption otomatik düşüm, min uyarısı.

- [ ] S7.3 images: yükleme (panel/mobil kamera), galeri, öncesi-sonrası, visible_to_patient; documents + onam şablonu + parmakla imza.

- [ ] S7.4 Ekip: tasks, channels, hasta dosyasına bağlı görev.

## Sprint 8 — Resmi Entegrasyonlar
- [ ] S8.1 e-Arşiv/e-Fatura entegratör adaptörü (sağlayıcı seçilince).

- [ ] S8.2 e-Nabız/ÜSS bildirimi (gereksinimler netleşince). Macro kapatma kontrol listesi.

## Sprint 9+ — SaaS
- [ ] Klinik onboarding sihirbazı, abonelik (iyzico recurring), süper-admin paneli, çoklu şube.
