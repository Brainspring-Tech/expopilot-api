const express  = require('express');
const router   = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const { getActiveGrantForOrg } = require('../services/accessGrants');
// Service-role client, used ONLY for the manual_access_grants lookup
// below — that table has RLS enabled with no policies (see its
// migration), so req.userClient would silently see zero rows even for a
// real active grant. Safe here because the org id passed in is always
// req.user.organization_id (the caller's own org from their verified
// session), never client-supplied input.
const supabase = require('../services/supabase');

router.use(requireAuth);

// GET /api/organizations/me
// Returns just what the admin console's Billing page needs — deliberately
// not the raw stripe_customer_id/stripe_subscription_id, since those are
// internal plumbing the frontend has no use for. has_billing_account is
// enough for the UI to decide "Subscribe" vs "Manage billing".
//
// prospect_finder_enabled added for the sidebar's Prospects nav item —
// same "return a derived/plain field, not raw internals" spirit as
// has_billing_account above. Also true when there's an active manual
// grant (see requireProspectFinderEnabled in prospectFinder.js) — a
// pilot grant includes Prospect Finder, not just the base plan — so the
// frontend unlocks /prospects with no separate flag to check.
//
// active_manual_grant surfaces a platform-operator-issued comp grant (see
// src/services/accessGrants.js) so BillingPage.jsx can show "you have
// free access" instead of funneling a pilot org into Stripe checkout —
// plan_status itself is left untouched (still whatever Stripe last said),
// so this is purely additive, not a fake "active" status.
router.get('/me', async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;

    const { data: org, error } = await req.userClient
      .from('organizations')
      .select('id, name, plan_status, plan_tier, trial_ends_at, stripe_customer_id, prospect_finder_enabled, fiscal_year_start_month')
      .eq('id', orgId)
      .maybeSingle();

    if (error) throw error;
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    const activeGrant = await getActiveGrantForOrg(orgId, supabase);

    res.json({
      id: org.id,
      name: org.name,
      plan_status: org.plan_status,
      plan_tier: org.plan_tier,
      trial_ends_at: org.trial_ends_at,
      has_billing_account: !!org.stripe_customer_id,
      prospect_finder_enabled: !!org.prospect_finder_enabled || !!activeGrant,
      fiscal_year_start_month: org.fiscal_year_start_month || 1,
      active_manual_grant: activeGrant
        ? { reason: activeGrant.reason, expires_at: activeGrant.expires_at }
        : null,
    });
  } catch (err) { next(err); }
});

// PATCH /api/organizations/me — admin only. Currently just
// fiscal_year_start_month (drives the Dashboard's budget trend chart
// period in conferences.js's /budget-summary endpoint); narrow allowlist
// on purpose since most of this row (plan_status, stripe ids, etc.) is
// managed by Stripe webhooks or the platform-operator console, not the
// org's own admin.
router.patch('/me', requireRole('admin'), async (req, res, next) => {
  try {
    const allowed = ['fiscal_year_start_month'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    if (updates.fiscal_year_start_month !== undefined) {
      const m = Number(updates.fiscal_year_start_month);
      if (!Number.isInteger(m) || m < 1 || m > 12) {
        return res.status(400).json({ error: 'fiscal_year_start_month must be an integer between 1 and 12' });
      }
      updates.fiscal_year_start_month = m;
    }

    const { data, error } = await req.userClient
      .from('organizations')
      .update(updates)
      .eq('id', req.user.organization_id)
      .select('id, fiscal_year_start_month')
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Organization not found' });
    res.json(data);
  } catch (err) { next(err); }
});

module.exports = router;
