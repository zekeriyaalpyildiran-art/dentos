import { createClient } from '@/lib/supabase';
import { NextResponse } from 'next/server';
import { createHash } from 'crypto';

// Clinic of the test login ahmet@klinik-maltepe.com, so RLS shows the seeded rows to that account.
const CLINIC_ID = 'd95ee452-9899-489d-8e8c-ea5dfbbdf84d';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const DOCTOR_ECE_ID = 'a0000000-0000-0000-0000-000000000001';
const DOCTOR_CEM_ID = 'a0000000-0000-0000-0000-000000000002';
const CHAIR_1_ID = 'b0000000-0000-0000-0000-000000000001';
const CHAIR_2_ID = 'b0000000-0000-0000-0000-000000000002';

// tc_hash stores a hash of the Turkish ID number, never the raw value.
const hashTc = (tc: string) => createHash('sha256').update(tc).digest('hex');

type TableResult = {
  table: string;
  status: 'success' | 'error';
  count?: number;
  message?: string;
};

async function seedDatabase() {
  const supabase = createClient();
  const results: TableResult[] = [];

  // Records each table's outcome so failures are reported instead of hidden.
  const record = (table: string, error: { message: string } | null, count: number) => {
    if (error) {
      console.warn(`⚠️ ${table} insert:`, error.message);
      results.push({ table, status: 'error', message: error.message });
    } else {
      results.push({ table, status: 'success', count });
    }
  };

  try {
    // 1. Insert clinic (ignoreDuplicates keeps the existing clinic's name and slug unchanged)
    console.log('Seeding clinic...');
    const { error: clinicError } = await supabase
      .from('clinics')
      .upsert(
        {
          id: CLINIC_ID,
          name: 'Klinik Merkezi',
          slug: 'klinik-merkezi',
          phone: '+90 (555) 100-0001',
          address: 'İstanbul, Türkiye',
          plan: 'trial',
        },
        { onConflict: 'id', ignoreDuplicates: true }
      );
    record('clinics', clinicError, 1);

    // 2. Insert users (admin, doctors)
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
          is_active: true,
        },
        {
          id: '44444444-4444-4444-4444-444444444444',
          clinic_id: CLINIC_ID,
          email: 'dr.cem@klinikmerkezi.com.tr',
          role: 'doctor',
          full_name: 'Dr. Cem Aydemir',
          is_active: true,
        },
      ]);
    record('users', usersError, 3);

    // 3. Insert doctors linked to the doctor users (specialty lives on doctors, not users)
    console.log('Seeding doctors...');
    const { error: doctorsError } = await supabase
      .from('doctors')
      .upsert([
        {
          id: DOCTOR_ECE_ID,
          clinic_id: CLINIC_ID,
          user_id: '33333333-3333-3333-3333-333333333333',
          specialty: 'Genel Diş Tedavisi',
        },
        {
          id: DOCTOR_CEM_ID,
          clinic_id: CLINIC_ID,
          user_id: '44444444-4444-4444-4444-444444444444',
          specialty: 'Ortodontisi',
        },
      ]);
    record('doctors', doctorsError, 2);

    // 4. Insert chairs (appointments require a chair_id)
    console.log('Seeding chairs...');
    const { error: chairsError } = await supabase
      .from('chairs')
      .upsert([
        { id: CHAIR_1_ID, clinic_id: CLINIC_ID, name: 'Koltuk 1', sort_order: 1 },
        { id: CHAIR_2_ID, clinic_id: CLINIC_ID, name: 'Koltuk 2', sort_order: 2 },
      ]);
    record('chairs', chairsError, 2);

    // 5. Insert patients
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
          gender: 'male',
          tc_hash: hashTc('12345678901'),
          address: 'İstanbul, Türkiye',
          kvkk_consent: true,
          consent_date: new Date().toISOString(),
        },
        {
          id: '66666666-6666-6666-6666-666666666666',
          clinic_id: CLINIC_ID,
          full_name: 'Mehmet Şahin',
          phone: '+90 (555) 234-5678',
          email: 'mehmet@example.com',
          birth_date: '1990-07-22',
          gender: 'male',
          tc_hash: hashTc('23456789012'),
          address: 'Ankara, Türkiye',
          kvkk_consent: true,
          consent_date: new Date().toISOString(),
        },
        {
          id: '77777777-7777-7777-7777-777777777777',
          clinic_id: CLINIC_ID,
          full_name: 'Selin Özkan',
          phone: '+90 (555) 345-6789',
          email: 'selin@example.com',
          birth_date: '1988-11-30',
          gender: 'female',
          tc_hash: hashTc('34567890123'),
          address: 'İzmir, Türkiye',
          kvkk_consent: true,
          consent_date: new Date().toISOString(),
        },
      ]);
    record('patients', patientsError, 3);

    // 6. Insert procedures (category values must match the procedure_category enum)
    console.log('Seeding procedures...');
    const { error: proceduresError } = await supabase
      .from('procedures_catalog')
      .upsert(
        [
          {
            clinic_id: CLINIC_ID,
            name: 'Diş Temizliği',
            description: 'Profesyonel diş temizliği ve tartar temizliği',
            category: 'cleaning',
            is_active: true,
          },
          {
            clinic_id: CLINIC_ID,
            name: 'Dolgu',
            description: 'Diş dolgusu (Composite)',
            category: 'filling',
            is_active: true,
          },
          {
            clinic_id: CLINIC_ID,
            name: 'Kuron',
            description: 'Diş kronları (Seramik)',
            category: 'crown',
            is_active: true,
          },
        ],
        { onConflict: 'clinic_id,name' }
      );
    record('procedures_catalog', proceduresError, 3);

    // 7. Insert appointments for tomorrow, 09:30-10:00 Istanbul time (UTC+3, no DST)
    console.log('Seeding appointments...');
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(
      new Date(Date.now() + 24 * 60 * 60 * 1000)
    );

    const { error: appointmentsError } = await supabase
      .from('appointments')
      .upsert([
        {
          clinic_id: CLINIC_ID,
          patient_id: '55555555-5555-5555-5555-555555555555',
          doctor_id: DOCTOR_ECE_ID,
          chair_id: CHAIR_2_ID,
          start_time: `${day}T09:30:00+03:00`,
          end_time: `${day}T10:00:00+03:00`,
          status: 'scheduled',
          notes: 'Rutin kontrol',
        },
      ]);
    record('appointments', appointmentsError, 1);

    const success = results.every((r) => r.status === 'success');
    return {
      success,
      message: success ? 'Database seeding complete' : 'Database seeding finished with errors',
      results,
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

// POST only: seeding writes data, so it must not run on a plain GET request.
// Fixture data is for local/dev use and is not written into production.
export async function POST() {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const result = await seedDatabase();
  return NextResponse.json(result, { status: result.success ? 200 : 500 });
}
