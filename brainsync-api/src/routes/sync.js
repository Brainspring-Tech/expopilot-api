const express  = require('express');
const router   = express.Router();
const supabase = require('../services/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');
const { syncLead, syncAllUnsynced } = require('../services/hubspot');

router.use(requireAuth);

// GET /api/sync/status — count of unsynced leads
router.get('/status', async (req, res, next) => {
  try {
    const { count, error } = await supabase
      .from('leads')
      .select('*', { count: 'exact', head: true })
      .eq('synced_to_hubspot', false);

    if (error) throw error;
    res.json({ unsynced_leads: count });
  } catch (err) { next(err); }
});

// POST /api/sync/run — manually trigger full sync (admin)
router.post('/run', requireRole('admin'), async (req, res, next) => {
  try {
    // Run async, respond immediately
    syncAllUnsynced().catch(e => console.error('[sync/run]', e.message));
    res.json({ message: 'Sync job started' });
  } catch (err) { next(err); }
});

// POST /api/sync/lead/:id — sync a single lead (admin)
router.post('/lead/:id', requireRole('admin'), async (req, res, next) => {
  try {
    await syncLead(req.params.id);
    const { data } = await supabase
      .from('leads')
      .select('id, synced_to_hubspot, hubspot_contact_id, synced_at')
      .eq('id', req.params.id)
      .single();
    res.json(data);
  } catch (err) { next(err); }
});

module.exports = router;
