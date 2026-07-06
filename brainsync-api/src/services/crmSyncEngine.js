const supabase = require('./supabase'); // service-role client
const { decrypt } = require('./crypto');
const hubspot = require('./hubspotIntegration');

const BATCH_SIZE = 100; // HubSpot's batch upsert limit

// Syncs one org's unsynced/failed leads to HubSpot. Always uses the
// service-role client — this is an internal engine function, not a
// request handler, so it doesn't rely on req.userClient/RLS. Callers
// (the cron job, or the admin-triggered manual-sync route) are
// responsible for org scoping: the cron job loops every enabled org,
// the manual route only ever passes the calling admin's own org.
async function syncOrgToHubSpot(organizationId) {
  const { data: integration, error: integrationError } = await supabase
    .from('crm_integrations')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('provider', 'hubspot')
    .eq('enabled', true)
    .maybeSingle();

  if (integrationError) throw integrationError;
  if (!integration) return { skipped: true, reason: 'No enabled HubSpot integration for this org' };

  let accessToken;
  try {
    accessToken = decrypt(integration.credentials_encrypted);
  } catch (err) {
    await markIntegrationResult(integration.id, 'error', `Could not decrypt stored credentials: ${err.message}`);
    return { skipped: true, reason: 'Credential decryption failed' };
  }

  // All leads belonging to this org's conferences.
  const { data: leads, error: leadsError } = await supabase
    .from('leads')
    .select('id, email, first_name, last_name, organization, phone, score, notes, conferences!inner(organization_id)')
    .eq('conferences.organization_id', organizationId)
    .not('email', 'is', null);

  if (leadsError) throw leadsError;
  if (!leads || leads.length === 0) {
    await markIntegrationResult(integration.id, 'success', null);
    return { synced: 0, failed: 0, total: 0 };
  }

  // Which of these leads already synced successfully? Only re-attempt
  // ones that are new or previously failed.
  const leadIds = leads.map(l => l.id);
  const { data: alreadySynced, error: syncedError } = await supabase
    .from('lead_crm_syncs')
    .select('lead_id')
    .eq('provider', 'hubspot')
    .eq('status', 'success')
    .in('lead_id', leadIds);

  if (syncedError) throw syncedError;
  const syncedIdSet = new Set((alreadySynced || []).map(r => r.lead_id));
  const pendingLeads = leads.filter(l => !syncedIdSet.has(l.id));

  if (pendingLeads.length === 0) {
    await markIntegrationResult(integration.id, 'success', null);
    return { synced: 0, failed: 0, total: 0 };
  }

  let syncedCount = 0;
  let failedCount = 0;
  let lastError = null;

  for (let i = 0; i < pendingLeads.length; i += BATCH_SIZE) {
    const batch = pendingLeads.slice(i, i + BATCH_SIZE);
    const results = await hubspot.upsertContactsBatch(accessToken, batch, integration.field_mappings);

    const upsertRows = results.map(r => ({
      lead_id: r.lead_id,
      provider: 'hubspot',
      external_id: r.external_id || null,
      synced_at: new Date().toISOString(),
      status: r.success ? 'success' : 'error',
      error_message: r.success ? null : r.error,
    }));

    const { error: upsertError } = await supabase
      .from('lead_crm_syncs')
      .upsert(upsertRows, { onConflict: 'lead_id,provider' });
    if (upsertError) throw upsertError;

    for (const r of results) {
      if (r.success) syncedCount++;
      else { failedCount++; lastError = r.error; }
    }
  }

  await markIntegrationResult(
    integration.id,
    failedCount === 0 ? 'success' : 'error',
    failedCount === 0 ? null : `${failedCount} lead(s) failed to sync. Last error: ${lastError}`
  );

  return { synced: syncedCount, failed: failedCount, total: pendingLeads.length };
}

async function markIntegrationResult(integrationId, status, errorMessage) {
  await supabase
    .from('crm_integrations')
    .update({
      last_synced_at: new Date().toISOString(),
      last_sync_status: status,
      last_sync_error: errorMessage,
    })
    .eq('id', integrationId);
}

// Called by the cron job — runs every org with an enabled HubSpot
// integration, one at a time (sequential, not parallel, to stay well
// under HubSpot's rate limits across multiple customers syncing at once).
async function syncAllOrgsToHubSpot() {
  const { data: integrations, error } = await supabase
    .from('crm_integrations')
    .select('organization_id')
    .eq('provider', 'hubspot')
    .eq('enabled', true);

  if (error) throw error;

  const results = [];
  for (const { organization_id } of integrations || []) {
    try {
      const result = await syncOrgToHubSpot(organization_id);
      results.push({ organization_id, ...result });
    } catch (err) {
      console.error(`[crmSync] HubSpot sync failed for org ${organization_id}:`, err.message);
      results.push({ organization_id, error: err.message });
    }
  }
  return results;
}

module.exports = { syncOrgToHubSpot, syncAllOrgsToHubSpot };
