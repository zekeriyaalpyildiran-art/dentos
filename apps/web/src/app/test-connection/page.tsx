'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase';

export default function TestConnectionPage() {
  const [status, setStatus] = useState<string>('Testing connection...');
  const [details, setDetails] = useState<any>(null);

  useEffect(() => {
    async function testConnection() {
      try {
        const supabase = createClient();

        // Test 1: Check auth
        setStatus('Testing authentication...');
        const { data: { session } } = await supabase.auth.getSession();
        setDetails(prev => ({ ...prev, auth: session ? 'Connected' : 'No session' }));

        // Test 2: Try simple query
        setStatus('Testing database connection...');
        const { data, error } = await supabase
          .from('clinics')
          .select('count')
          .limit(1);

        if (error) {
          setStatus('❌ Database Error: ' + error.message);
          setDetails({ error: error });
        } else {
          setStatus('✅ Database Connected!');
          setDetails(prev => ({ ...prev, database: 'Connected', data }));
        }
      } catch (err) {
        setStatus('❌ Connection Error: ' + String(err));
        setDetails({ error: err });
      }
    }

    testConnection();
  }, []);

  return (
    <div style={{ padding: '32px', fontFamily: 'monospace' }}>
      <h1>🔌 Supabase Connection Test</h1>
      <p style={{ fontSize: '18px', marginTop: '16px' }}>{status}</p>
      <pre style={{ background: '#f5f5f5', padding: '16px', borderRadius: '8px', overflow: 'auto' }}>
        {JSON.stringify(details, null, 2)}
      </pre>
    </div>
  );
}
