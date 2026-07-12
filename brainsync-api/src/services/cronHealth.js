const supabase = require('./supabase');

// Upserts one row per job — always reflects the MOST RECENT run, not a
// growing history. Called from each cron job's own try/catch so a
// recording failure here never masks or replaces the job's own error
// handling (console logging stays as-is; this is purely additive).
async function recordCronRun(jobName, { success, error, summary } = {}) {
  const now = new Date().toISOString();
  const updates = {
    job_name: jobName,
    last_run_at: now,
    last_run_status: success ? 'success' : 'error',
    last_error_message: success ? null : (error || 'Unknown error'),
    last_run_summary: summary || null,
    updated_at: now,
  };
  if (success) updates.last_success_at = now;

  try {
    await supabase.from('cron_job_health').upsert(updates, { onConflict: 'job_name' });
  } catch (err) {
    console.error(`[cronHealth] failed to record run for ${jobName}:`, err.message);
  }
}

module.exports = { recordCronRun };
