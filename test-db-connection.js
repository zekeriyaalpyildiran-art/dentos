#!/usr/bin/env node

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const connectionString = process.env.DATABASE_URL ||
  'postgresql://postgres:yE9eDS44m42l5ZV8@db.knzrcgqpzjbajfboqlhq.supabase.co:5432/postgres';

console.log('🔌 Testing PostgreSQL Connection');
console.log('================================\n');

// Try different host variations
const hosts = [
  'db.knzrcgqpzjbajfboqlhq.supabase.co',
  '104.18.38.10', // IP from nslookup
  '172.64.149.246', // IP from nslookup
  'localhost',
];

async function testConnection(host) {
  const pool = new Pool({
    host,
    port: 5432,
    database: 'postgres',
    user: 'postgres',
    password: 'yE9eDS44m42l5ZV8',
    connectTimeoutMillis: 5000,
    idleTimeoutMillis: 5000,
  });

  try {
    const client = await pool.connect();
    const result = await client.query('SELECT version()');
    console.log(`✅ Connected to ${host}`);
    console.log(`   PostgreSQL: ${result.rows[0].version.split(',')[0]}\n`);

    client.release();
    return true;
  } catch (err) {
    console.log(`❌ Failed to connect to ${host}`);
    console.log(`   Error: ${err.code || err.message}\n`);
    return false;
  } finally {
    await pool.end();
  }
}

async function testConnections() {
  console.log('Testing different hosts...\n');

  for (const host of hosts) {
    const success = await testConnection(host);
    if (success) {
      console.log(`\n🎯 Use host: ${host}`);
      return host;
    }
  }

  console.log('\n❌ Could not connect to any host');
  console.log('\nTrying Supabase Health Check...');

  try {
    const fetch = require('node-fetch');
    const response = await fetch('https://knzrcgqpzjbajfboqlhq.supabase.co/rest/v1/');
    console.log(`✅ Supabase API is online (${response.status})`);
    console.log('   Database server may be down or unreachable');
  } catch (err) {
    console.log(`❌ Supabase API unreachable: ${err.message}`);
  }
}

testConnections().catch(console.error);
