const express  = require('express');
const router   = express.Router();
const { requireAuth, requirePlatformOperator } = require('../middleware/auth');
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
      .select('id, name, slug, created_at, trial_ends_at, plan_status, vision_scan_limit, seat_limit');
    if (orgsError) throw orgsError;

    const orgIds = orgs.map((o) => o.id);

    const startOfMonth = new Date();
    startOfMonth.setUTCDate(1);
    startOfMonth.setUTCHours(0, 0, 0, 0);

    const [usersRes, conferencesRes, visionUsageRes, topupsRes] = await Promise.all([
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
    ]);

    if (usersRes.error) throw usersRes.error;
    if (conferencesRes.error) throw conferencesRes.error;
    if (visionUsageRes.error) throw visionUsageRes.error;
    if (topupsRes.error) throw topupsRes.error;

    const seatCounts = countBy(usersRes.data, 'organization_id');
    const conferenceCounts = countBy(conferencesRes.data, 'organization_id');
    const scanCounts = countBy(visionUsageRes.data, 'organization_id');
    const topupTotals = sumBy(topupsRes.data, 'organization_id', 'scans_granted');

    const result = orgs
      .map((org) => ({
        id: org.id,
        name: org.name,
        slug: org.slug,
        created_at: org.created_at,
        trial_ends_at: org.trial_ends_at,
        plan_status: org.plan_status,
        seats_used: seatCounts.get(org.id) || 0,
        seat_limit: org.seat_limit,
        scans_used_this_month: scanCounts.get(org.id) || 0,
        scans_included: org.vision_scan_limit,
        topup_scans_this_month: topupTotals.get(org.id) || 0,
        conference_count: conferenceCounts.get(org.id) || 0,
      }))
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

module.exports = router;
