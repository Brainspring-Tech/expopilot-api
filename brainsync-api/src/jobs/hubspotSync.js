const cron     = require('node-cron');
const supabase = require('../services/supabase');
const { syncAllUnsynced } = require('../services/hubspot');
const { sendDailyLeadSummary } = require('../services/email');

function startSyncJob() {
  // Sync unsynced leads every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    console.log('[cron] running HubSpot sync');
    try {
      await syncAllUnsynced();
    } catch (err) {
      console.error('[cron] sync error:', err.message);
    }
  });

  // Daily lead summary email at 6pm (18:00) every show day
  cron.schedule('0 18 * * *', async () => {
    console.log('[cron] sending daily lead summaries');
    try {
      await sendDailyConferenceSummaries();
    } catch (err) {
      console.error('[cron] summary email error:', err.message);
    }
  });

  console.log('[cron] jobs scheduled: HubSpot sync (*/15 min), daily summary (18:00)');
}

async function sendDailyConferenceSummaries() {
  const today = new Date().toISOString().split('T')[0];

  // Find active conferences happening today
  const { data: activeConfs } = await supabase
    .from('conferences')
    .select('id, name')
    .eq('status', 'active')
    .lte('start_date', today)
    .gte('end_date', today);

  if (!activeConfs || activeConfs.length === 0) return;

  // Get admin emails
  const { data: admins } = await supabase
    .from('users')
    .select('email')
    .eq('role', 'admin');

  const adminEmails = (admins || []).map(a => a.email);
  if (adminEmails.length === 0) return;

  for (const conf of activeConfs) {
    const { count: total } = await supabase
      .from('leads')
      .select('*', { count: 'exact', head: true })
      .eq('conference_id', conf.id);

    const { count: hot } = await supabase
      .from('leads')
      .select('*', { count: 'exact', head: true })
      .eq('conference_id', conf.id)
      .gte('score', 4);

    for (const email of adminEmails) {
      await sendDailyLeadSummary({
        adminEmail:     email,
        conferenceName: conf.name,
        totalLeads:     total || 0,
        hotLeads:       hot   || 0,
        date:           today,
      }).catch(e => console.error('[cron] email error:', e.message));
    }
  }
}

module.exports = { startSyncJob };
