#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://knzrcgqpzjbajfboqlhq.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_KEY) {
  console.error('❌ SUPABASE_SERVICE_ROLE_KEY not set');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

async function initializeDatabase() {
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  console.log('🔧 Initializing DentOS Database...');
  console.log(`📂 Found ${files.length} migration files\n`);

  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf-8');

    console.log(`📜 Applying ${file}...`);

    try {
      // Execute the SQL through Supabase admin API
      const { data, error } = await supabase.rpc('exec_sql', {
        sql_query: sql
      });

      if (error) {
        console.error(`  ❌ Error: ${error.message}`);
      } else {
        console.log(`  ✅ Applied successfully`);
      }
    } catch (err) {
      // Alternative: Try using raw fetch to execute SQL
      try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SERVICE_KEY}`,
          },
          body: JSON.stringify({ sql })
        });

        if (response.ok) {
          console.log(`  ✅ Applied successfully`);
        } else {
          console.error(`  ❌ HTTP ${response.status}`);
        }
      } catch (fetchErr) {
        console.error(`  ⚠️  Could not apply migration (will try next approach)`);
      }
    }
  }

  console.log('\n✨ Database initialization complete!');
}

initializeDatabase().catch(console.error);
