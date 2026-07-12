const express  = require('express');
const router   = express.Router();
const { requireAuth, requirePlatformOperator } = require('../middleware/auth');
const {
  validateGrantInput,
  getGrantsForOrg,
  getActiveGrantForOrg,
  logPlatformAction,
} = require('../services/accessGrants');
const supabase = require('../services/supabase'); // service-role client —
                                                    // intentional: this route's
                                                    // whole purpose is reading
                                                    // across ALL orgs, which
                                                    // req.userClient (RLS-scoped)
                                                    // would correctly refuse to do.

router.use(requireAuth);
router.use(requirePlatformOperator);

function countBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    map.set(row[key], (map.get(row[key]) || 0) + 1);
  }
  return map;
}

function sumBy(rows, key, valueKey) {
  const map = new Map();
  for (const row of rows) {
    map.set(row[key], (map.get(row[key]) || 0) + (row[valueKey] || 0));
  }
  return map;
}

// GET /api/platform/overview
// Cross-org snapshot for the platform operator: signup/trial status,
// billing status, seat usage, scan usage this month (base + top-ups),
// and conference count as a rough activity signal. Only reachable by
// accounts with is_platform_operator = true (see requirePlatformOperator).
router.get('/overview', async (req, res, next) => {
  try {
    const { data: orgs, error: orgsError } = await supabase
      .from('organizations')
      .select('id, name, slug, created_at, trial_ends_at, plan_status, vision_scan_limit, seat_limit, last_payment_failed_at, payment_failure_count');
    if (orgsError) throw orgsError;

    const orgIds = orgs.map((o) => o.id);

    const startOfMonth = new Date();
    startOfMonth.setUTCDate(1);
    startOfMonth.setUTCHours(0, 0, 0, 0);

    const [usersRes, conferencesRes, visionUsageRes, topupsRes, grantsRes, crmRes] = await Promise.all([
      supabase.from('users').select('organization_id').in('organization_id', orgIds),
      supabase.from('conferences').select('organization_id').in('organization_id', orgIds),
      supabase
        .from('vision_usage')
        .select('organization_id')
        .in('organization_id', orgIds)
        .gte('created_at', startOfMonth.toISOString()),
      supabase
        .from('vision_topups')
        .select('organization_id, scans_granted')
        .in('organization_id', orgIds)
        .gte('created_at', startOfMonth.toISOString()),
      supabase
        .from('manual_access_grants')
        .select('organization_id, expires_at, starts_at, revoked_at, reason')
        .in('organization_id', orgIds)
        .is('revoked_at', null)
        .gt('expires_at', new Date().toISOString()),
      supabase
        .from('crm_integrations')
        .select('organization_id, provider, enabled, last_synced_at, last_sync_status, last_sync_error')
        .in('organization_id', orgIds),
    ]);

    if (usersRes.error) throw usersRes.error;
    if (conferencesRes.error) throw conferencesRes.error;
    if (visionUsageRes.error) throw visionUsageRes.error;
    if (topupsRes.error) throw topupsRes.error;
    if (grantsRes.error) throw grantsRes.error;
    if (crmRes.error) throw crmRes.error;

    const seatCounts = countBy(usersRes.data, 'organization_id');
    const conferenceCounts = countBy(conferencesRes.data, 'organization_id');
    const scanCounts = countBy(visionUsageRes.data, 'organization_id');
    const topupTotals = sumBy(topupsRes.data, 'organization_id', 'scans_granted');
    // One row per (org, provider) today (just HubSpot) — keyed by org
    // since the UI shows one sync-health cell per org, not per provider.
    const crmByOrg = new Map();
    for (const row of crmRes.data) crmByOrg.set(row.organization_id, row);

    // Only unrevoked, unexpired grants were fetched above, so any row
    // present here is by definition "currently active" — keep the
    // furthest-expiring one per org in the unlikely case more than one
    // overlaps (matches findActiveGrant's tie-break in accessGrants.js).
    const activeGrantByOrg = new Map();
    for (const grant of grantsRes.data) {
      const existing = activeGrantByOrg.get(grant.organization_id);
      if (!existing || new Date(grant.expires_at) > new Date(existing.expires_at)) {
        activeGrantByOrg.set(grant.organization_id, grant);
      }
    }

    const result = orgs
      .map((org) => {
        const activeGrant = activeGrantByOrg.get(org.id) || null;
        const crm = crmByOrg.get(org.id) || null;
        return {
          id: org.id,
          name: org.name,
          slug: org.slug,
          created_at: org.created_at,
          trial_ends_at: org.trial_ends_at,
          plan_status: org.plan_status,
          last_payment_failed_at: org.last_payment_failed_at,
          payment_failure_count: org.payment_failure_count || 0,
          seats_used: seatCounts.get(org.id) || 0,
          seat_limit: org.seat_limit,
          scans_used_this_month: scanCounts.get(org.id) || 0,
          scans_included: org.vision_scan_limit,
          topup_scans_this_month: topupTotals.get(org.id) || 0,
          conference_count: conferenceCounts.get(org.id) || 0,
          active_manual_grant: activeGrant
            ? { expires_at: activeGrant.expires_at, reason: activeGrant.reason }
            : null,
          crm_sync: crm
            ? {
                provider: crm.provider,
                enabled: crm.enabled,
                last_synced_at: crm.last_synced_at,
                status: crm.last_sync_status,
                error: crm.last_sync_error,
              }
            : null,
        };
      })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json({
      organizations: result,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/platform/organizations/:id
// Updates seat_limit and/or vision_scan_limit for a single org. Deliberately
// NOT exposed to org admins themselves (see /api/organizations/me, which
// only ever reads) — these numbers represent what a customer is actually
// paying for, so only the platform operator can change them. A customer
// editing their own limits would let them grant themselves unlimited
// seats/scans for free, which defeats the entire point of having a limit.
//
// Both fields are optional and independently updatable — only whichever
// keys are present in the body get touched. Passing null explicitly clears
// a limit back to "unlimited" (matches how vision.js's getEffectiveLimit
// already treats NULL). Anything else must be a non-negative integer.
router.patch('/organizations/:id', async (req, res, next) => {
  try {
    const { seat_limit, vision_scan_limit } = req.body;
    const updates = {};

    function validateLimit(value, fieldName) {
      if (value === null) return null;
      if (value === undefined) return undefined;
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) {
        throw Object.assign(
          new Error(`${fieldName} must be a non-negative integer, or null for unlimited`),
          { status: 400 }
        );
      }
      return n;
    }

    if ('seat_limit' in req.body) {
      updates.seat_limit = validateLimit(seat_limit, 'seat_limit');
    }
    if ('vision_scan_limit' in req.body) {
      updates.vision_scan_limit = validateLimit(vision_scan_limit, 'vision_scan_limit');
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Provide at least one of: seat_limit, vision_scan_limit' });
    }

    const { data, error } = await supabase
      .from('organizations')
      .update(updates)
      .eq('id', req.params.id)
      .select('id, name, seat_limit, vision_scan_limit')
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Organization not found' });

    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/platform/users/lookup?email=someone@example.com
// Resolves which organization a given person belongs to, so the platform
// operator can grant free access having only a pilot contact's email —
// they don't need to already know the org's name/id. Not paginated /
// fuzzy on purpose: exact-email lookup only, same spirit as this being an
// operator tool rather than a general directory search.
router.get('/users/lookup', async (req, res, next) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email query param is required' });

    const { data: user, error } = await supabase
      .from('users')
      .select('id, full_name, email, organization_id, organizations(id, name, slug, plan_status)')
      .ilike('email', email)
      .maybeSingle();

    if (error) throw error;
    if (!user) return res.status(404).json({ error: 'No user found with that email' });

    res.json({
      user: { id: user.id, full_name: user.full_name, email: user.email },
      organization: user.organizations,
    });
  } catch (err) { next(err); }
});

// GET /api/platform/access-grants
// Every manual access grant ever issued, across all orgs, newest first —
// the "who granted what, when, and why" audit view. Distinct from
// /organizations/:id/access-grants below (which is scoped to one org and
// used right after issuing/revoking a grant for that org).
router.get('/access-grants', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('manual_access_grants')
      .select(`
        id, organization_id, reason, starts_at, expires_at, revoked_at, created_at,
        organizations(name, slug),
        granted_by:granted_by_user_id(full_name, email),
        revoked_by:revoked_by_user_id(full_name, email)
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/platform/organizations/:id/access-grants
// Full grant history (active, expired, and revoked) for a single org.
router.get('/organizations/:id/access-grants', async (req, res, next) => {
  try {
    const grants = await getGrantsForOrg(req.params.id);
    res.json(grants);
  } catch (err) { next(err); }
});

// POST /api/platform/organizations/:id/access-grants
// Body: { months?: number (default 12), reason: string }
// Grants an org free platform access for the given number of months,
// bypassing Stripe entirely — for Expo Pilot / beta testers giving
// usability feedback, not paying customers. Rejects a second active grant
// for the same org (the frontend should surface "revoke the existing
// grant first" rather than silently stacking grants); a NEW grant can
// always be issued once the old one is revoked or has expired.
router.post('/organizations/:id/access-grants', async (req, res, next) => {
  try {
    const organizationId = req.params.id;
    const months = req.body.months === undefined ? 12 : req.body.months;
    const reason = req.body.reason;

    const errors = validateGrantInput({ months, reason });
    if (errors.length > 0) {
      return res.status(400).json({ error: errors.join('; ') });
    }

    const { data: org, error: orgError } = await supabase
      .from('organizations')
      .select('id, name')
      .eq('id', organizationId)
      .maybeSingle();
    if (orgError) throw orgError;
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    const existingActiveGrant = await getActiveGrantForOrg(organizationId);
    if (existingActiveGrant) {
      return res.status(409).json({
        error: `${org.name} already has an active grant (expires ${existingActiveGrant.expires_at}). Revoke it before issuing a new one.`,
        code: 'ACTIVE_GRANT_EXISTS',
      });
    }

    const startsAt = new Date();
    const expiresAt = new Date(startsAt);
    expiresAt.setUTCMonth(expiresAt.getUTCMonth() + Number(months));

    const { data: grant, error: insertError } = await supabase
      .from('manual_access_grants')
      .insert({
        organization_id: organizationId,
        granted_by_user_id: req.user.id,
        reason: reason.trim(),
        starts_at: startsAt.toISOString(),
        expires_at: expiresAt.toISOString(),
      })
      .select()
      .single();
    if (insertError) throw insertError;

    await logPlatformAction({
      actorUserId: req.user.id,
      action: 'access_grant.created',
      targetOrganizationId: organizationId,
      metadata: { grant_id: grant.id, months: Number(months), reason: grant.reason, expires_at: grant.expires_at },
    });

    res.status(201).json(grant);
  } catch (err) { next(err); }
});

// POST /api/platform/access-grants/:grantId/revoke
// Cuts off a manual grant immediately (sets revoked_at/revoked_by) —
// access checks re-evaluate on the next request, no separate "sync" step
// needed since nothing caches this. Revoking an already-revoked or
// already-expired grant is a no-op that still succeeds, since the end
// state the caller wants ("this grant no longer confers access") already
// holds either way.
router.post('/access-grants/:grantId/revoke', async (req, res, next) => {
  try {
    const { data: grant, error: fetchError } = await supabase
      .from('manual_access_grants')
      .select('id, organization_id, revoked_at')
      .eq('id', req.params.grantId)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!grant) return res.status(404).json({ error: 'Grant not found' });

    if (grant.revoked_at) {
      return res.json(grant);
    }

    const { data: updated, error: updateError } = await supabase
      .from('manual_access_grants')
      .update({ revoked_at: new Date().toISOString(), revoked_by_user_id: req.user.id })
      .eq('id', req.params.grantId)
      .select()
      .single();
    if (updateError) throw updateError;

    await logPlatformAction({
      actorUserId: req.user.id,
      action: 'access_grant.revoked',
      targetOrganizationId: grant.organization_id,
      metadata: { grant_id: grant.id },
    });

    res.json(updated);
  } catch (err) { next(err); }
});

// GET /api/platform/feedback
// Cross-org feedback inbox for the platform operator — every org's
// submissions in one place, newest first. Service-role client (same
// reasoning as /overview above): the RLS policy on `feedback` only lets
// an org's own admin read their own org's rows, which is correct for
// req.userClient but is exactly what this route needs to bypass.
// Capped at 500 most-recent rows — revisit with real pagination if
// volume ever outgrows that.
router.get('/feedback', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('feedback')
      .select('*, organizations(name), users(full_name, email)')
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/platform/cron-health
// One row per background job (see src/services/cronHealth.js and each
// job in src/jobs/*.js) — previously invisible entirely, since these
// jobs only ever logged to Render's console. Reflects each job's MOST
// RECENT run only, not a history; a job that's never run yet (e.g.
// weekly digest before its first Monday) simply won't have a row.
router.get('/cron-health', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('cron_job_health')
      .select('*')
      .order('job_name');

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

module.exports = router;
