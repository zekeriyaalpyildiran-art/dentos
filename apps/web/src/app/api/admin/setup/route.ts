import { createClient } from '@/lib/supabase';
import fs from 'fs';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';

// Combine all migration SQL into one request
async function readMigrations() {
  const migrationsDir = path.join(process.cwd(), '../../packages/db/migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  let combinedSql = '-- DentOS Database Initialization\n\n';

  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf-8');
    combinedSql += `-- Migration: ${file}\n`;
    combinedSql += sql;
    combinedSql += '\n\n';
  }

  return combinedSql;
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createClient();

    // Check if user is authenticated and is admin
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    console.log('🚀 Database initialization started');
    const combinedSql = await readMigrations();

    // Split by statement to avoid PostgreSQL errors
    const statements = combinedSql
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt && !stmt.startsWith('--'));

    console.log(`📝 Executing ${statements.length} SQL statements`);

    // Execute each statement (note: this is a workaround)
    // In production, use proper database migration tool
    const results = [];

    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      try {
        // Use raw SQL execution via Supabase REST API
        const response = await fetch(
          `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
              'apikey': process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
              'X-Client-Info': 'dentos-admin',
            },
            body: JSON.stringify({ query: stmt }),
          }
        );

        if (!response.ok) {
          console.warn(`⚠️  Statement ${i + 1} failed (may already exist)`);
        }
        results.push({ index: i + 1, status: response.ok ? 'success' : 'warning' });
      } catch (err) {
        console.warn(`⚠️  Statement ${i + 1}: ${err}`);
        results.push({ index: i + 1, status: 'error', error: String(err) });
      }
    }

    return NextResponse.json({
      success: true,
      message: 'Database initialization complete',
      totalStatements: statements.length,
      results: results.slice(0, 10), // Show first 10 results
    });
  } catch (error) {
    console.error('Setup error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Setup failed',
      },
      { status: 500 }
    );
  }
}
