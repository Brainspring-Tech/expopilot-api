const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth');

// All vision routes require a logged-in user — this is a paid API call,
// not a public endpoint.
router.use(requireAuth);

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

// Rate limit specifically for the scan endpoint — this is the one route
// that costs real money per call (~$0.01/scan: one business-card image
// plus a short JSON completion). This is separate from, and in addition
// to, the monthly vision_scan_limit/top-up quota below — that quota caps
// total monthly cost per org, but only if it's actually configured
// (defaults to null/unlimited until an org's limit is set). This limiter
// exists specifically to bound worst-case cost from a single runaway
// client — a buggy retry loop, or a compromised/scripted account — even
// when the monthly quota isn't set or hasn't been hit yet.
//
// Keyed on the logged-in user, not IP: several staffers on the same
// conference WiFi shouldn't share one bucket, and this should follow the
// account regardless of network.
//
// 100 requests/hour ≈ $1/hour worst case at ~$0.01/scan — generous enough
// that a real staffer scanning a big stack of cards in a rush never hits
// it, but bounds a runaway script well before it costs anything real.
const scanRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: {
    error: 'Too many scan requests from this account in the last hour. Please wait a bit, or add this lead manually in the meantime.',
  },
});

// Start of the current calendar month, in ISO form. Scoping usage counts
// to "since this timestamp" gives a monthly window that resets itself
// naturally — no cron job needed.
function startOfCurrentMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

// Effective limit for the current month = base vision_scan_limit + any
// one-time top-ups purchased THIS calendar month. Top-ups are scoped by
// created_at the same way vision_usage is, so a top-up bought in June
// doesn't silently carry over and inflate July's limit — it just stops
// counting once the month rolls over, same natural reset as everything
// else here.
async function getEffectiveLimit(client, orgId, baseLimit) {
  if (baseLimit == null) return null; // unlimited org, no need to check topups

  const { data: topups, error } = await client
    .from('vision_topups')
    .select('scans_granted')
    .eq('organization_id', orgId)
    .gte('created_at', startOfCurrentMonth());

  if (error) throw error;

  const topupTotal = (topups || []).reduce((sum, t) => sum + t.scans_granted, 0);
  return baseLimit + topupTotal;
}

// POST /api/vision/business-card
// Body: { image: '<base64 string, no data: prefix>', mediaType: 'image/jpeg' }
// Returns: { text: '<raw model response text>' }
//
// The frontend used to call Anthropic directly with an API key embedded in
// the PWA bundle (VITE_ANTHROPIC_API_KEY), which exposed the key to anyone
// who opened dev tools. This route moves that call server-side so the key
// lives only in Render's environment (ANTHROPIC_API_KEY, no VITE_ prefix —
// never exposed to the client build).
//
// Enforces an optional per-organization monthly cap (organizations.
// vision_scan_limit, plus any current-month top-ups) before making the
// call, and logs every successful call to vision_usage — this is the one
// feature that costs real money per use, so it's the one place that needs
// cost visibility and control as more organizations sign up. Also enforced
// by scanRateLimiter above, independent of the monthly quota.
router.post('/business-card', scanRateLimiter, async (req, res, next) => {
  try {
    const { image, mediaType } = req.body;
    if (!image) {
      return res.status(400).json({ error: 'image (base64) is required' });
    }

    const orgId = req.user.organization_id;

    const { data: org, error: orgError } = await req.userClient
      .from('organizations')
      .select('vision_scan_limit')
      .eq('id', orgId)
      .maybeSingle();

    if (orgError) throw orgError;

    const effectiveLimit = await getEffectiveLimit(req.userClient, orgId, org?.vision_scan_limit);

    if (effectiveLimit != null) {
      const { count, error: countError } = await req.userClient
        .from('vision_usage')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId)
        .gte('created_at', startOfCurrentMonth());

      if (countError) throw countError;

      if (count >= effectiveLimit) {
        return res.status(429).json({
          error: `Your organization has reached its monthly limit of ${effectiveLimit} AI-assisted card scans. You can still add this lead manually, or purchase a scan top-up.`,
        });
      }
    }

    const response = await axios.post(
      ANTHROPIC_API_URL,
      {
        model: MODEL,
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } },
            { type: 'text', text: 'Extract contact info from this business card. Return only a JSON object with fields: first_name, last_name, email, phone, organization, title. Use empty string for missing fields.' },
          ],
        }],
      },
      {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      }
    );

    const text = response.data?.content?.[0]?.text || '';

    // Log usage only on success — a failed Anthropic call didn't cost
    // anything, so it shouldn't count against the org's limit. Deliberately
    // not awaited: a logging hiccup shouldn't slow down or fail the actual
    // scan the person is waiting on.
    req.userClient
      .from('vision_usage')
      .insert({ organization_id: orgId, user_id: req.user.id })
      .then(({ error }) => {
        if (error) console.error('[vision] failed to record usage:', error.message);
      });

    res.json({ text });
  } catch (err) {
    if (err.response) {
      console.error('[vision] Anthropic API error', err.response.status, err.response.data);
      return res.status(502).json({ error: 'Vision service error — please try again' });
    }
    next(err);
  }
});

// GET /api/vision/usage — current month's scan count and effective limit
// (base + any top-ups purchased this month) for the caller's organization.
// Powers the "AI scans used: 42 / 300 this month" widget. Deliberately NOT
// behind scanRateLimiter — this is a free read, not a paid API call.
router.get('/usage', async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;

    const { data: org, error: orgError } = await req.userClient
      .from('organizations')
      .select('vision_scan_limit')
      .eq('id', orgId)
      .maybeSingle();

    if (orgError) throw orgError;

    const effectiveLimit = await getEffectiveLimit(req.userClient, orgId, org?.vision_scan_limit);

    const { count, error: countError } = await req.userClient
      .from('vision_usage')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .gte('created_at', startOfCurrentMonth());

    if (countError) throw countError;

    res.json({ used: count || 0, limit: effectiveLimit });
  } catch (err) { next(err); }
});

module.exports = router;
