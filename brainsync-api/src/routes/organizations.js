const express  = require('express');
const router   = express.Router();
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/organizations/me
// Returns just what the admin console's Billing page needs — deliberately
// not the raw stripe_customer_id/stripe_subscription_id, since those are
// internal plumbing the frontend has no use for. has_billing_account is
// enough for the UI to decide "Subscribe" vs "Manage billing".
router.get('/me', async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;

    const { data: org, error } = await req.userClient
      .from('organizations')
      .select('id, name, plan_status, trial_ends_at, stripe_customer_id')
      .eq('id', orgId)
      .maybeSingle();

    if (error) throw error;
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    res.json({
      id: org.id,
      name: org.name,
      plan_status: org.plan_status,
      trial_ends_at: org.trial_ends_at,
      has_billing_account: !!org.stripe_customer_id,
    });
  } catch (err) { next(err); }
});

module.exports = router;
