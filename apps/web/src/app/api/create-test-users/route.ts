import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export async function POST() {
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
        name: 'Ahmet Yılmaz'
      },
      {
        email: 'admin@klinikmerkezi.com.tr',
        password: 'password',
        name: 'Admin Kullanıcı'
      },
      {
        email: 'dr.ece@klinikmerkezi.com.tr',
        password: 'password',
        name: 'Dr. Ece Kara'
      },
      {
        email: 'dr.cem@klinikmerkezi.com.tr',
        password: 'password',
        name: 'Dr. Cem Aydemir'
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
          results.push({
            email: user.email,
            status: 'success',
            id: data.user?.id,
          });
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
