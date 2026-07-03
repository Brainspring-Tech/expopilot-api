const axios    = require('axios');
const supabase = require('./supabase');
 
// TEMPORARY: HubSpot sync is only wired up for a single portal (Brainspring's).
// Until per-org HubSpot credentials are built (see multi-tenancy follow-ups),
// any lead belonging to a different organization is skipped rather than
// synced into Brainspring's HubSpot account.
const BRAINSPRING_ORG_ID = process.env.BRAINSPRING_ORG_ID;
 
if (!BRAINSPRING_ORG_ID) {
  console.warn('[hubspot] BRAINSPRING_ORG_ID is not set — all syncs will be skipped.');
}
 
const hs = axios.create({
  baseURL: 'https://api.hubapi.com',
  headers: {
    Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  },
  timeout: 10000,
});
 
// Queue a single lead for HubSpot sync (called immediately on capture)
async function queueHubSpotSync(leadId) {
  // Mark as pending — the cron job will process it
  // For immediate capture we also attempt inline sync
  await syncLead(leadId);
}
 
// Sync a single lead to HubSpot (upsert contact, tag with conference)
async function syncLead(leadId) {
  const { data: lead, error } = await supabase
    .from('leads')
    .select('*, conferences(name, city, state, organization_id)')
    .eq('id', leadId)
    .single();
 
  if (error || !lead) {
    console.error('[hubspot] lead not found:', leadId);
    return;
  }
 
  // Org gate: leads belong to an org indirectly via their conference.
  // Only Brainspring leads sync until per-org HubSpot credentials exist.
  const leadOrgId = lead.conferences?.organization_id;
  if (!BRAINSPRING_ORG_ID || leadOrgId !== BRAINSPRING_ORG_ID) {
    console.log(`[hubspot] skipping lead ${leadId} — org ${leadOrgId || 'unknown'} is not Brainspring`);
    return;
  }
 
  if (!lead.email && !lead.first_name) {
    console.warn('[hubspot] lead has no email or name, skipping:', leadId);
    return;
  }
 
  try {
    const properties = buildContactProperties(lead);
    let contactId = lead.hubspot_contact_id;
 
    if (contactId) {
      // Update existing contact
      await hs.patch(`/crm/v3/objects/contacts/${contactId}`, { properties });
    } else {
      // Search for existing contact by email first
      if (lead.email) {
        const search = await hs.post('/crm/v3/objects/contacts/search', {
          filterGroups: [{
            filters: [{ propertyName: 'email', operator: 'EQ', value: lead.email }]
          }],
          properties: ['email'],
          limit: 1,
        });
 
        if (search.data.total > 0) {
          contactId = search.data.results[0].id;
          await hs.patch(`/crm/v3/objects/contacts/${contactId}`, { properties });
        }
      }
 
      // Create new contact if still no match
      if (!contactId) {
        const create = await hs.post('/crm/v3/objects/contacts', { properties });
        contactId = create.data.id;
      }
    }
 
    // Mark synced in Supabase
    await supabase
      .from('leads')
      .update({
        hubspot_contact_id: contactId,
        synced_to_hubspot: true,
        synced_at: new Date().toISOString(),
      })
      .eq('id', leadId);
 
    console.log(`[hubspot] synced lead ${leadId} → contact ${contactId}`);
  } catch (err) {
    console.error(`[hubspot] sync failed for lead ${leadId}:`, err.response?.data || err.message);
  }
}
 
// Sync all unsynced leads (called by cron job)
async function syncAllUnsynced() {
  if (!BRAINSPRING_ORG_ID) {
    console.warn('[hubspot cron] BRAINSPRING_ORG_ID not set — skipping run entirely.');
    return;
  }
 
  // Join through conferences to only pull leads belonging to Brainspring's org.
  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, conferences!inner(organization_id)')
    .eq('synced_to_hubspot', false)
    .eq('conferences.organization_id', BRAINSPRING_ORG_ID)
    .limit(50);
 
  if (error) { console.error('[hubspot cron] query error:', error.message); return; }
  if (!leads || leads.length === 0) return;
 
  console.log(`[hubspot cron] syncing ${leads.length} unsynced leads (Brainspring only)`);
  for (const { id } of leads) {
    await syncLead(id);
    await sleep(200); // avoid HubSpot rate limit
  }
}
 
function buildContactProperties(lead) {
  const conf = lead.conferences;
  return {
    firstname:          lead.first_name   || '',
    lastname:           lead.last_name    || '',
    email:              lead.email        || '',
    phone:              lead.phone        || '',
    company:            lead.organization || '',
    jobtitle:           lead.title        || '',
    // Custom HubSpot properties — create these in your HubSpot portal
    brainsync_conference:    conf?.name   || '',
    brainsync_interest_tags: (lead.interest_tags || []).join('; '),
    brainsync_grade_levels:  (lead.grade_levels  || []).join('; '),
    brainsync_lead_score:    String(lead.score   || ''),
    brainsync_notes:         lead.notes          || '',
  };
}
 
const sleep = ms => new Promise(r => setTimeout(r, ms));
 
module.exports = { queueHubSpotSync, syncLead, syncAllUnsynced };
 
