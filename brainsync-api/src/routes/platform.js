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

module.exports = router;
