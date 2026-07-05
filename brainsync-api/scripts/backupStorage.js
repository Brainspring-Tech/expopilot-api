/**
 * Daily backup sync: conference-attachments -> conference-attachments-backup
 *
 * Design notes:
 * - Authenticates as a dedicated, restricted Supabase Auth user (NOT the
 *   service_role key). That user can SELECT from the source bucket and
 *   INSERT/UPDATE into the backup bucket, but has no DELETE grant anywhere.
 *   This means a compromised admin account, an app bug, or misuse of the
 *   normal API credentials cannot reach into the backup bucket to destroy it.
 * - Deletions on the source are intentionally NOT propagated to the backup.
 *   If a file disappears from conference-attachments, it stays in the backup
 *   until manually cleaned up. That's the point of the backup existing.
 * - Only new/changed files are re-uploaded each run (compares size + updated
 *   timestamp), so daily runs after the first are cheap.
 * - Exits non-zero on any failure so Render Cron Job history flags failed runs.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const BACKUP_EMAIL = process.env.BACKUP_SERVICE_EMAIL;
const BACKUP_PASSWORD = process.env.BACKUP_SERVICE_PASSWORD;

const SOURCE_BUCKET = process.env.BACKUP_SOURCE_BUCKET || 'conference-attachments';
const BACKUP_BUCKET = process.env.BACKUP_TARGET_BUCKET || 'conference-attachments-backup';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !BACKUP_EMAIL || !BACKUP_PASSWORD) {
  console.error(
    'Missing required environment variables. Need: SUPABASE_URL, SUPABASE_ANON_KEY, ' +
      'BACKUP_SERVICE_EMAIL, BACKUP_SERVICE_PASSWORD.'
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function signIn() {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: BACKUP_EMAIL,
    password: BACKUP_PASSWORD,
  });
  if (error) {
    throw new Error(`Backup service sign-in failed: ${error.message}`);
  }
  return data.session;
}

/**
 * Recursively lists every file in a bucket (Supabase's list() is not
 * recursive by default — folders come back as entries with id === null).
 */
async function listAllFiles(bucket, prefix = '') {
  const results = [];
  const { data, error } = await supabase.storage.from(bucket).list(prefix, {
    limit: 1000,
    sortBy: { column: 'name', order: 'asc' },
  });

  if (error) {
    throw new Error(`Failed to list ${bucket}/${prefix || '(root)'}: ${error.message}`);
  }

  for (const entry of data) {
    const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.id === null) {
      // Folder placeholder — descend into it.
      const nested = await listAllFiles(bucket, fullPath);
      results.push(...nested);
    } else {
      results.push({
        path: fullPath,
        size: entry.metadata?.size ?? null,
        updatedAt: entry.updated_at ?? entry.created_at ?? null,
      });
    }
  }

  return results;
}

function needsSync(sourceFile, backupIndex) {
  const existing = backupIndex.get(sourceFile.path);
  if (!existing) return true;
  if (sourceFile.size !== existing.size) return true;
  if (sourceFile.updatedAt && existing.updatedAt) {
    if (new Date(sourceFile.updatedAt) > new Date(existing.updatedAt)) return true;
  }
  return false;
}

async function syncFile(path) {
  const { data: fileData, error: downloadError } = await supabase.storage
    .from(SOURCE_BUCKET)
    .download(path);

  if (downloadError) {
    throw new Error(`Download failed: ${downloadError.message}`);
  }

  const arrayBuffer = await fileData.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const { error: uploadError } = await supabase.storage
    .from(BACKUP_BUCKET)
    .upload(path, buffer, {
      upsert: true,
      contentType: fileData.type || undefined,
    });

  if (uploadError) {
    throw new Error(`Upload failed: ${uploadError.message}`);
  }
}

async function run() {
  const startedAt = new Date().toISOString();
  console.log(`[${startedAt}] Starting storage backup sync (${SOURCE_BUCKET} -> ${BACKUP_BUCKET})`);

  await signIn();
  console.log('Authenticated as backup service account.');

  const [sourceFiles, backupFiles] = await Promise.all([
    listAllFiles(SOURCE_BUCKET),
    listAllFiles(BACKUP_BUCKET),
  ]);

  console.log(`Source has ${sourceFiles.length} files. Backup currently has ${backupFiles.length}.`);

  const backupIndex = new Map(backupFiles.map((f) => [f.path, f]));

  let synced = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of sourceFiles) {
    try {
      if (needsSync(file, backupIndex)) {
        await syncFile(file.path);
        synced++;
        console.log(`  synced:    ${file.path}`);
      } else {
        skipped++;
      }
    } catch (err) {
      failed++;
      console.error(`  FAILED:    ${file.path} — ${err.message}`);
    }
  }

  const finishedAt = new Date().toISOString();
  console.log(
    `[${finishedAt}] Done. ${synced} synced, ${skipped} unchanged, ${failed} failed ` +
      `(source total: ${sourceFiles.length}).`
  );

  if (failed > 0) {
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error('Backup sync crashed:', err);
  process.exit(1);
});
