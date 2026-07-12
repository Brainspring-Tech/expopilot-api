const cron     = require('node-cron');
const supabase = require('../services/supabase');
const { sendWeeklyAdminDigest, sendWeeklyPersonalSummary } = require('../services/email');
const { notifyIfEnabled } = require('../services/notifications');
const { recordCronRun } = require('../services/cronHealth');

function startWeeklyDigestJob() {
  // Monday 8am — one weekly rollup per org (admins) and per staff member
  // who actually captured a lead in the past week (personal summary).
  cron.schedule('0 8 * * 1', async () => {
    console.log('[cron] sending weekly digests');
    const failed = [];
    try {
      await sendWeeklyAdminDigests();
    } catch (err) {
      console.error('[cron] weekly admin digest error:', err.message);
      failed.push({ label: 'admin digests', error: err.message });
    }
    try {
      await sendWeeklyPersonalSummaries();
    } catch (err) {
      console.error('[cron] weekly personal summary error:', err.message);
      failed.push({ label: 'personal summaries', error: err.message });
    }

    await recordCronRun('weekly_digest', {
      success: failed.length === 0,
      error: failed.length > 0 ? failed.map(f => `${f.label}: ${f.error}`).join('; ') : undefined,
    });
  });

  console.log('[cron] job scheduled: weekly digest (Mon 08:00)');
}

async function sendWeeklyAdminDigests() {
  const today   = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const weekOut  = new Date(today);
  weekOut.setDate(weekOut.getDate() + 7);
  const weekOutStr = weekOut.toISOString().split('T')[0];

  const { data: orgs } = await supabase.from('organizations').select('id');
  if (!orgs || orgs.length === 0) return;

  for (const org of orgs) {
    // Excludes completed/cancelled — a finished conference's stale
    // 'pending' assets or open tasks aren't an actionable heads-up.
    const { data: orgConfs } = await supabase
      .from('conferences')
      .select('id, name, start_date, status')
      .eq('organization_id', org.id);

    const liveConfs = (orgConfs || []).filter(c => !['completed', 'cancelled'].includes(c.status));
    const confIds   = liveConfs.map(c => c.id);
    const upcoming  = liveConfs
      .filter(c => c.start_date >= todayStr && c.start_date <= weekOutStr)
      .sort((a, b) => a.start_date.localeCompare(b.start_date));

    let openTaskCount = 0;
    let unshippedAssetCount = 0;

    if (confIds.length > 0) {
      const { count: taskCount } = await supabase
        .from('tasks')
        .select('*', { count: 'exact', head: true })
        .in('conference_id', confIds)
        .neq('status', 'done');
      openTaskCount = taskCount || 0;

      const { count: assetCount } = await supabase
        .from('booth_assets')
        .select('*', { count: 'exact', head: true })
        .in('conference_id', confIds)
        .in('status', ['pending', 'packed']);
      unshippedAssetCount = assetCount || 0;
    }

    // Skip the org entirely if there's nothing to report — an empty
    // digest every Monday is noise, not a rollup.
    if (upcoming.length === 0 && openTaskCount === 0 && unshippedAssetCount === 0) continue;

    const { data: admins } = await supabase
      .from('users')
      .select('id')
      .eq('organization_id', org.id)
      .eq('role', 'admin');

    for (const admin of (admins || [])) {
      notifyIfEnabled(admin.id, 'weekly_admin_digest', recipient => sendWeeklyAdminDigest({
        adminEmail: recipient.email,
        upcomingConferences: upcoming.map(c => ({ name: c.name, start_date: c.start_date })),
        openTaskCount,
        unshippedAssetCount,
      }));
    }
  }
}

async function sendWeeklyPersonalSummaries() {
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);

  // Query leads directly rather than iterating every user — naturally
  // scopes to whoever actually captured something this week (staff,
  // lead_capture, or an admin who worked a booth), no role filter needed.
  const { data: recentLeads } = await supabase
    .from('leads')
    .select('captured_by, conference_id')
    .gte('captured_at', weekAgo.toISOString());

  const byUser = {};
  for (const lead of (recentLeads || [])) {
    if (!lead.captured_by) continue;
    if (!byUser[lead.captured_by]) byUser[lead.captured_by] = { count: 0, confs: new Set() };
    byUser[lead.captured_by].count++;
    byUser[lead.captured_by].confs.add(lead.conference_id);
  }

  for (const [userId, stats] of Object.entries(byUser)) {
    notifyIfEnabled(userId, 'weekly_personal_summary', recipient => sendWeeklyPersonalSummary({
      staffEmail: recipient.email,
      staffName: recipient.full_name,
      leadsCaptured: stats.count,
      conferenceCount: stats.confs.size,
    }));
  }
}

module.exports = { startWeeklyDigestJob };
