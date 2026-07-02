const express  = require('express');
const router   = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const { syncLead, syncAllUnsynced } = require('../services/hubspot');

router.use(requireAuth);

// GET /api/sync/status — count of unsynced leads in the caller's org.
// Switched to req.userClient — previously used the service-role client
// and counted unsynced leads across every organization.
router.get('/status', async (req, res, next) => {
  try {
    const { count, error } = await req.userClient
      .from('leads')
      .select('*', { count: 'exact', head: true })
      .eq('synced_to_hubspot', false);

    if (error) throw error;
    res.json({ unsynced_leads: count });
  } catch (err) { next(err); }
});

// POST /api/sync/run — manually trigger full sync (admin).
//
// ⚠️ KNOWN LIMITATION, NOT FIXED HERE: syncAllUnsynced() appears to sync
// every unsynced lead in the database to a single, global HubSpot
// account (HUBSPOT_ACCESS_TOKEN). Once a second organization exists on
// this platform, running this would push THEIR leads into Brainspring's
// HubSpot account. Fixing this properly requires either per-organization
// HubSpot credentials, or restricting this endpoint to Brainspring only
// until that's built — needs a design decision, not a quick patch, and
// needs to see services/hubspot.js to do safely.
router.post('/run', requireRole('admin'), async (req, res, next) => {
  try {
    // Run async, respond immediately
    syncAllUnsynced().catch(e => console.error('[sync/run]', e.message));
    res.json({ message: 'Sync job started' });
  } catch (err) { next(err); }
});

// POST /api/sync/lead/:id — sync a single lead (admin). Added an
// explicit check that the lead is visible to the caller under RLS
// (their own org) before syncing it — previously used the service-role
// client with no check, so any admin could sync any lead in the
// database regardless of organization.
router.post('/lead/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { data: lead, error: leadError } = await req.userClient
      .from('leads')
      .select('id')
      .eq('id', req.params.id)
      .maybeSingle();

    if (leadError) throw leadError;
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    await syncLead(req.params.id);

    const { data } = await req.userClient
      .from('leads')
      .select('id, synced_to_hubspot, hubspot_contact_id, synced_at')
      .eq('id', req.params.id)
      .single();
    res.json(data);
  } catch (err) { next(err); }
});

module.exports = router;
