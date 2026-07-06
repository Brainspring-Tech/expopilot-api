const express = require('express');
const router  = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const { encrypt } = require('../services/crypto');
const hubspot = require('../services/hubspotIntegration');
const { syncOrgToHubSpot } = require('../services/crmSyncEngine');

router.use(requireAuth);

// GET /api/integrations — admin: list this org's configured
// integrations. Deliberately never selects credentials_encrypted — the
// frontend only ever needs to know connection status, not the secret.
router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { data, error } = await req.userClient
      .from('crm_integrations')
      .select('id, provider, enabled, field_mappings, last_synced_at, last_sync_status, last_sync_error')
      .eq('organization_id', req.user.organization_id);

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/integrations/hubspot — admin: connect (or replace) the
// org's HubSpot Private App token. Validates the token against HubSpot
// BEFORE saving — a bad token should fail loudly here, not silently on
// the next cron run three hours from now.
router.post('/hubspot', requireRole('admin'), async (req, res, next) => {
  try {
    const { access_token } = req.body;
    if (!access_token || !access_token.trim()) {
      return res.status(400).json({ error: 'access_token is required' });
    }

    const validation = await hubspot.validateToken(access_token.trim());
    if (!validation.valid) {
      return res.status(400).json({ error: `HubSpot rejected this token: ${validation.error}` });
    }

    const credentials_encrypted = encrypt(access_token.trim());

    const { data, error } = await req.userClient
      .from('crm_integrations')
      .upsert({
        organization_id: req.user.organization_id,
        provider: 'hubspot',
        enabled: true,
        credentials_encrypted,
        last_sync_status: null,
        last_sync_error: null,
      }, { onConflict: 'organization_id,provider' })
      .select('id, provider, enabled, field_mappings, last_synced_at, last_sync_status, last_sync_error')
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

// PATCH /api/integrations/hubspot/mappings — admin: adjust which
// ExpoPilot lead fields map to which HubSpot contact properties.
router.patch('/hubspot/mappings', requireRole('admin'), async (req, res, next) => {
  try {
    const { field_mappings } = req.body;
    if (!field_mappings || typeof field_mappings !== 'object') {
      return res.status(400).json({ error: 'field_mappings object is required' });
    }

    const { data, error } = await req.userClient
      .from('crm_integrations')
      .update({ field_mappings })
      .eq('organization_id', req.user.organization_id)
      .eq('provider', 'hubspot')
      .select('id, provider, enabled, field_mappings, last_synced_at, last_sync_status, last_sync_error')
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'No HubSpot integration found — connect one first' });
    res.json(data);
  } catch (err) { next(err); }
});

// PATCH /api/integrations/hubspot/toggle — admin: pause/resume syncing
// without losing the stored token or field mappings.
router.patch('/hubspot/toggle', requireRole('admin'), async (req, res, next) => {
  try {
    const { enabled } = req.body;
    const { data, error } = await req.userClient
      .from('crm_integrations')
      .update({ enabled: !!enabled })
      .eq('organization_id', req.user.organization_id)
      .eq('provider', 'hubspot')
      .select('id, provider, enabled, field_mappings, last_synced_at, last_sync_status, last_sync_error')
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'No HubSpot integration found' });
    res.json(data);
  } catch (err) { next(err); }
});

// DELETE /api/integrations/hubspot — admin: fully disconnect, removing
// the stored token entirely (not just disabling).
router.delete('/hubspot', requireRole('admin'), async (req, res, next) => {
  try {
    const { error } = await req.userClient
      .from('crm_integrations')
      .delete()
      .eq('organization_id', req.user.organization_id)
      .eq('provider', 'hubspot');

    if (error) throw error;
    res.status(204).send();
  } catch (err) { next(err); }
});

// POST /api/integrations/hubspot/sync — admin: manual "Sync now".
// Explicitly scoped to req.user.organization_id only — this route must
// never be able to trigger a sync for any org other than the caller's
// own, unlike the cron job which intentionally loops every org.
router.post('/hubspot/sync', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await syncOrgToHubSpot(req.user.organization_id);
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
