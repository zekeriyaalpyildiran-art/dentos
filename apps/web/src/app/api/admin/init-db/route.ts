import { createClient } from '@/lib/supabase';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

export const maxDuration = 300; // 5 minute timeout

export async function POST(request: Request) {
  try {
    const supabase = createClient();

    // Read migration files
    const migrationsPath = join(process.cwd(), '../../packages/db/migrations');
    const files = await readdir(migrationsPath);
    const sqlFiles = files.filter(f => f.endsWith('.sql')).sort();

    console.log(`🚀 Initializing database with ${sqlFiles.length} migrations`);

    const results = [];

    for (const file of sqlFiles) {
      const filePath = join(migrationsPath, file);
      const sql = await readFile(filePath, 'utf-8');

      console.log(`Applying ${file}...`);

      try {
        // Execute SQL through Supabase client
        const { error } = await supabase.rpc('exec_sql_batch', {
          sql_batch: sql
        });

        if (error) {
          results.push({ file, status: 'error', message: error.message });
          console.error(`❌ ${file}: ${error.message}`);
        } else {
          results.push({ file, status: 'success' });
          console.log(`✅ ${file}`);
        }
      } catch (err) {
        results.push({ file, status: 'error', message: String(err) });
        console.error(`❌ ${file}: ${err}`);
      }
    }

    const successful = results.filter(r => r.status === 'success').length;

    return Response.json({
      success: true,
      message: `Database initialization complete. ${successful}/${sqlFiles.length} migrations applied.`,
      results,
      appliedCount: successful,
      totalCount: sqlFiles.length
    });
  } catch (error) {
    console.error('Database initialization error:', error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        message: 'Failed to initialize database'
      },
      { status: 500 }
    );
  }
}
