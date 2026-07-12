const cron = require('node-cron');
const { syncAllOrgsToHubSpot } = require('../services/crmSyncEngine');
const { recordCronRun } = require('../services/cronHealth');

// Runs every 15 minutes, syncing every org with an enabled HubSpot
// integration. Separate from the existing Brainspring-specific
// startSyncJob (jobs/hubspotSync.js) — that one keeps running as-is;
// this is the new customer-facing, multi-tenant path.
function startCrmSyncJob() {
  cron.schedule('*/15 * * * *', async () => {
    try {
      const results = await syncAllOrgsToHubSpot();
      const synced = results.reduce((sum, r) => sum + (r.synced || 0), 0);
      const failed = results.reduce((sum, r) => sum + (r.failed || 0), 0);
      if (results.length > 0) {
        console.log(`[crmSync] Ran for ${results.length} org(s): ${synced} synced, ${failed} failed`);
      }
      // Reflects whether the CRON ITSELF completed, not whether any
      // individual org's sync succeeded — per-org failures are already
      // tracked on crm_integrations.last_sync_error (see PlatformPage's
      // CRM sync column). This is the "did the batch even run" signal.
      await recordCronRun('crm_sync', { success: true, summary: { orgs: results.length, synced, failed } });
    } catch (err) {
      console.error('[crmSync] Cron run failed:', err.message);
      await recordCronRun('crm_sync', { success: false, error: err.message });
    }
  });
}

module.exports = { startCrmSyncJob };
