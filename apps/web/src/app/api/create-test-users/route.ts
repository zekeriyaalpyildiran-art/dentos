import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

// Clinic of the test login ahmet@klinik-maltepe.com.
const TEST_CLINIC_ID = 'd95ee452-9899-489d-8e8c-ea5dfbbdf84d';

export async function POST() {
  // Creates accounts with a known password, so it is only available outside production.
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAdminKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseAdminKey) {
      return NextResponse.json(
        { error: 'Missing Supabase configuration' },
        { status: 500 }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseAdminKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    const testUsers = [
      {
        email: 'ahmet@klinik-maltepe.com',
        password: 'password',
        name: 'Ahmet Yılmaz',
        role: 'owner'
      },
      {
        email: 'admin@klinikmerkezi.com.tr',
        password: 'password',
        name: 'Admin Kullanıcı',
        role: 'admin'
      },
      {
        email: 'dr.ece@klinikmerkezi.com.tr',
        password: 'password',
        name: 'Dr. Ece Kara',
        role: 'doctor'
      },
      {
        email: 'dr.cem@klinikmerkezi.com.tr',
        password: 'password',
        name: 'Dr. Cem Aydemir',
        role: 'doctor'
      }
    ];

    const results = [];

    for (const user of testUsers) {
      try {
        const { data, error } = await supabase.auth.admin.createUser({
          email: user.email,
          password: user.password,
          email_confirm: true,
          user_metadata: { name: user.name },
        });

        if (error) {
          results.push({
            email: user.email,
            status: 'error',
            message: error.message,
          });
        } else {
          // getCurrentUser() looks up public.users by auth_user_id; without this row sign-in lands back on /login.
          const { error: profileError } = await supabase.from('users').upsert(
            {
              auth_user_id: data.user?.id,
              clinic_id: TEST_CLINIC_ID,
              role: user.role,
              full_name: user.name,
              email: user.email,
            },
            { onConflict: 'clinic_id,email' }
          );

          if (profileError) {
            results.push({
              email: user.email,
              status: 'error',
              message: `Auth user created, but users row failed: ${profileError.message}`,
            });
          } else {
            results.push({
              email: user.email,
              status: 'success',
              id: data.user?.id,
            });
          }
        }
      } catch (err) {
        results.push({
          email: user.email,
          status: 'error',
          message: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    return NextResponse.json({
      success: true,
      message: 'Test users creation completed',
      results,
    });
  } catch (error) {
    console.error('Error creating test users:', error);
    return NextResponse.json(
      { error: 'Failed to create test users' },
      { status: 500 }
    );
  }
}
