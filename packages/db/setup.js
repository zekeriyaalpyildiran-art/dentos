#!/usr/bin/env node

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('❌ Missing environment variables: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

async function executeSql(sql) {
  try {
    const { data, error } = await supabase.rpc('exec_sql', { sql });
    if (error) throw error;
    return data;
  } catch (err) {
    console.error('SQL Error:', err.message);
    throw err;
  }
}

async function setupDatabase() {
  console.log('🚀 DentOS Database Setup');
  console.log('========================\n');

  // Read all migration files
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  console.log(`📂 Found ${files.length} migrations\n`);

  let appliedCount = 0;

  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf-8');

    console.log(`📝 ${file}`);

    try {
      await executeSql(sql);
      console.log(`   ✅ Success\n`);
      appliedCount++;
    } catch (err) {
      console.log(`   ⚠️  ${err.message}\n`);
    }
  }

  console.log(`\n✨ Setup complete! (${appliedCount}/${files.length} migrations)\n`);
  return appliedCount === files.length;
}

setupDatabase()
  .then(success => process.exit(success ? 0 : 1))
  .catch(err => {
    console.error('❌ Setup failed:', err);
    process.exit(1);
  });
