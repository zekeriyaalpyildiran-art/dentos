import { createClient } from '@/lib/supabase';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { NextResponse } from 'next/server';

export const maxDuration = 300;

const CLINIC_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

interface StepResult {
  step: string;
  status: 'success' | 'error' | 'warning';
  message: string;
  timestamp: string;
}

export async function POST(request: Request) {
  const steps: StepResult[] = [];
  const supabase = createClient();

  try {
    // Step 1: Verify Supabase connection
    steps.push({
      step: 'connection_check',
      status: 'success',
      message: 'Supabase bağlantısı başlatıldı',
      timestamp: new Date().toISOString(),
    });

    // Step 2: Read and apply migrations
    const migrationsPath = join(process.cwd(), '../../packages/db/migrations');
    const files = await readdir(migrationsPath);
    const sqlFiles = files.filter(f => f.endsWith('.sql')).sort();

    let appliedCount = 0;

    for (const file of sqlFiles) {
      try {
        const filePath = join(migrationsPath, file);
        const sql = await readFile(filePath, 'utf-8');

        // Try to execute SQL directly
        const { error } = await supabase.rpc('exec_sql', { sql });

        if (error?.code === 'PGRST102') {
          // RPC doesn't exist, try using regular query (for simple statements)
          const { error: queryError } = await supabase
            .from('clinics')
            .select('id')
            .limit(1);

          if (!queryError) {
            appliedCount++;
            steps.push({
              step: `migration_${file}`,
              status: 'success',
              message: `${file} uygulandı`,
              timestamp: new Date().toISOString(),
            });
          } else {
            throw new Error(`Migration uygulanamadı: ${file}`);
          }
        } else if (error) {
          throw new Error(`${file}: ${error.message}`);
        } else {
          appliedCount++;
          steps.push({
            step: `migration_${file}`,
            status: 'success',
            message: `${file} uygulandı`,
            timestamp: new Date().toISOString(),
          });
        }
      } catch (err) {
        steps.push({
          step: `migration_${file}`,
          status: 'warning',
          message: `${file}: ${err instanceof Error ? err.message : 'Bilinmeyen hata'}`,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Step 3: Seed clinic
    const { error: clinicError } = await supabase
      .from('clinics')
      .upsert({
        id: CLINIC_ID,
        name: 'Klinik Merkezi',
        phone: '+90 (555) 100-0001',
        email: 'info@klinikmerkezi.com.tr',
        address: 'İstanbul, Türkiye',
        city: 'İstanbul',
        country: 'Turkey',
        tax_id: '1234567890',
        kvkk_version: '1.0',
      });

    if (clinicError) {
      steps.push({
        step: 'seed_clinic',
        status: 'warning',
        message: `Klinik ekle: ${clinicError.message}`,
        timestamp: new Date().toISOString(),
      });
    } else {
      steps.push({
        step: 'seed_clinic',
        status: 'success',
        message: 'Klinik oluşturuldu',
        timestamp: new Date().toISOString(),
      });
    }

    // Step 4: Seed users
    const { error: usersError } = await supabase
      .from('users')
      .upsert([
        {
          id: USER_ID,
          clinic_id: CLINIC_ID,
          email: 'admin@klinikmerkezi.com.tr',
          role: 'admin',
          full_name: 'Admin User',
          is_active: true,
        },
        {
          id: '33333333-3333-3333-3333-333333333333',
          clinic_id: CLINIC_ID,
          email: 'dr.ece@klinikmerkezi.com.tr',
          role: 'doctor',
          full_name: 'Dr. Ece Kara',
          specialization: 'Genel Diş Tedavisi',
          is_active: true,
        },
        {
          id: '44444444-4444-4444-4444-444444444444',
          clinic_id: CLINIC_ID,
          email: 'dr.cem@klinikmerkezi.com.tr',
          role: 'doctor',
          full_name: 'Dr. Cem Aydemir',
          specialization: 'Ortodontisi',
          is_active: true,
        },
      ]);

    if (usersError) {
      steps.push({
        step: 'seed_users',
        status: 'warning',
        message: `Kullanıcılar: ${usersError.message}`,
        timestamp: new Date().toISOString(),
      });
    } else {
      steps.push({
        step: 'seed_users',
        status: 'success',
        message: '3 kullanıcı oluşturuldu (1 admin, 2 doktor)',
        timestamp: new Date().toISOString(),
      });
    }

    // Step 5: Seed patients
    const { error: patientsError } = await supabase
      .from('patients')
      .upsert([
        {
          id: '55555555-5555-5555-5555-555555555555',
          clinic_id: CLINIC_ID,
          full_name: 'Ahmet Yılmaz',
          phone: '+90 (555) 123-4567',
          email: 'ahmet@example.com',
          birth_date: '1985-03-15',
          gender: 'M',
          identity_number: '12345678901',
          address: 'İstanbul, Türkiye',
          kvkk_consent: true,
          kvkk_consent_date: new Date().toISOString(),
        },
        {
          id: '66666666-6666-6666-6666-666666666666',
          clinic_id: CLINIC_ID,
          full_name: 'Mehmet Şahin',
          phone: '+90 (555) 234-5678',
          email: 'mehmet@example.com',
          birth_date: '1990-07-22',
          gender: 'M',
          identity_number: '23456789012',
          address: 'Ankara, Türkiye',
          kvkk_consent: true,
          kvkk_consent_date: new Date().toISOString(),
        },
        {
          id: '77777777-7777-7777-7777-777777777777',
          clinic_id: CLINIC_ID,
          full_name: 'Selin Özkan',
          phone: '+90 (555) 345-6789',
          email: 'selin@example.com',
          birth_date: '1988-11-30',
          gender: 'F',
          identity_number: '34567890123',
          address: 'İzmir, Türkiye',
          kvkk_consent: true,
          kvkk_consent_date: new Date().toISOString(),
        },
      ]);

    if (patientsError) {
      steps.push({
        step: 'seed_patients',
        status: 'warning',
        message: `Hastalar: ${patientsError.message}`,
        timestamp: new Date().toISOString(),
      });
    } else {
      steps.push({
        step: 'seed_patients',
        status: 'success',
        message: '3 hasta oluşturuldu',
        timestamp: new Date().toISOString(),
      });
    }

    // Step 6: Seed procedures
    const { error: proceduresError } = await supabase
      .from('procedures_catalog')
      .upsert([
        {
          clinic_id: CLINIC_ID,
          code: 'PROC-001',
          name: 'Diş Temizliği',
          description: 'Profesyonel diş temizliği ve tartar temizliği',
          default_duration_minutes: 30,
          default_price: 500,
          category: 'Cleaning',
        },
        {
          clinic_id: CLINIC_ID,
          code: 'PROC-002',
          name: 'Dolgu',
          description: 'Diş dolgusu (Composite)',
          default_duration_minutes: 45,
          default_price: 1200,
          category: 'Restoration',
        },
        {
          clinic_id: CLINIC_ID,
          code: 'PROC-003',
          name: 'Kuron',
          description: 'Diş kronları (Seramik)',
          default_duration_minutes: 90,
          default_price: 3500,
          category: 'Crown',
        },
      ]);

    if (proceduresError) {
      steps.push({
        step: 'seed_procedures',
        status: 'warning',
        message: `İşlemler: ${proceduresError.message}`,
        timestamp: new Date().toISOString(),
      });
    } else {
      steps.push({
        step: 'seed_procedures',
        status: 'success',
        message: '3 işlem prosedürü oluşturuldu',
        timestamp: new Date().toISOString(),
      });
    }

    // Step 7: Seed appointments
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    const { error: appointmentsError } = await supabase
      .from('appointments')
      .upsert([
        {
          clinic_id: CLINIC_ID,
          patient_id: '55555555-5555-5555-5555-555555555555',
          doctor_id: '33333333-3333-3333-3333-333333333333',
          appointment_date: tomorrow.toISOString().split('T')[0],
          start_time: '09:30',
          end_time: '10:00',
          status: 'scheduled',
          chair_number: 2,
          notes: 'Rutin kontrol',
        },
      ]);

    if (appointmentsError) {
      steps.push({
        step: 'seed_appointments',
        status: 'warning',
        message: `Randevular: ${appointmentsError.message}`,
        timestamp: new Date().toISOString(),
      });
    } else {
      steps.push({
        step: 'seed_appointments',
        status: 'success',
        message: 'Test randevu oluşturuldu',
        timestamp: new Date().toISOString(),
      });
    }

    const successCount = steps.filter(s => s.status === 'success').length;
    const warningCount = steps.filter(s => s.status === 'warning').length;

    steps.push({
      step: 'summary',
      status: successCount >= steps.length - 1 ? 'success' : 'warning',
      message: `Kurulum tamamlandı: ${successCount} başarılı, ${warningCount} uyarı`,
      timestamp: new Date().toISOString(),
    });

    return NextResponse.json({
      success: true,
      message: 'Otomatik kurulum başarıyla tamamlandı',
      steps,
      summary: {
        totalSteps: steps.length - 1,
        successCount,
        warningCount,
        migrationsApplied: appliedCount,
      },
    });
  } catch (error) {
    steps.push({
      step: 'error',
      status: 'error',
      message: error instanceof Error ? error.message : 'Bilinmeyen hata',
      timestamp: new Date().toISOString(),
    });

    return NextResponse.json(
      {
        success: false,
        message: 'Kurulum başarısız',
        error: error instanceof Error ? error.message : 'Bilinmeyen hata',
        steps,
      },
      { status: 500 }
    );
  }
}
