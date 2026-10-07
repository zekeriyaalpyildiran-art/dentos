import { createClient } from '@/lib/supabase';
import { NextResponse } from 'next/server';

const CLINIC_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

async function seedDatabase() {
  const supabase = createClient();
  const results: any[] = [];

  try {
    // 1. Insert clinic
    console.log('Seeding clinic...');
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
      console.warn('⚠️ Clinic insert:', clinicError.message);
    } else {
      results.push({ table: 'clinics', status: 'success' });
    }

    // 2. Insert users (doctor, admin)
    console.log('Seeding users...');
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
      console.warn('⚠️ Users insert:', usersError.message);
    } else {
      results.push({ table: 'users', status: 'success', count: 3 });
    }

    // 3. Insert patients
    console.log('Seeding patients...');
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
      console.warn('⚠️ Patients insert:', patientsError.message);
    } else {
      results.push({ table: 'patients', status: 'success', count: 3 });
    }

    // 4. Insert procedures
    console.log('Seeding procedures...');
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
      console.warn('⚠️ Procedures insert:', proceduresError.message);
    } else {
      results.push({ table: 'procedures_catalog', status: 'success', count: 3 });
    }

    // 5. Insert appointments
    console.log('Seeding appointments...');
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
      console.warn('⚠️ Appointments insert:', appointmentsError.message);
    } else {
      results.push({ table: 'appointments', status: 'success', count: 1 });
    }

    return {
      success: true,
      message: 'Database seeding complete',
      results,
      details: {
        clinic: CLINIC_ID,
        users: 3,
        patients: 3,
        procedures: 3,
        appointments: 1,
      },
    };
  } catch (error) {
    console.error('Seed error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Seeding failed',
      results,
    };
  }
}

export async function POST() {
  const result = await seedDatabase();
  return NextResponse.json(result);
}

export async function GET() {
  const result = await seedDatabase();
  return NextResponse.json(result);
}
