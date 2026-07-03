const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const { requireAuth } = require('../middleware/auth');

// All vision routes require a logged-in user — this is a paid API call,
// not a public endpoint.
router.use(requireAuth);

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

// Start of the current calendar month, in ISO form. Scoping usage counts
// to "since this timestamp" gives a monthly window that resets itself
// naturally — no cron job needed.
function startOfCurrentMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
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
// vision_scan_limit) before making the call, and logs every successful
// call to vision_usage — this is the one feature that costs real money
// per use, so it's the one place that needs cost visibility and control
// as more organizations sign up.
router.post('/business-card', async (req, res, next) => {
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

    if (org?.vision_scan_limit != null) {
      const { count, error: countError } = await req.userClient
        .from('vision_usage')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId)
        .gte('created_at', startOfCurrentMonth());

      if (countError) throw countError;

      if (count >= org.vision_scan_limit) {
        return res.status(429).json({
          error: `Your organization has reached its monthly limit of ${org.vision_scan_limit} AI-assisted card scans. You can still add this lead manually — contact support to increase your limit.`,
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

// GET /api/vision/usage — current month's scan count and limit for the
// caller's organization. Not used by the UI yet, but ready for a small
// "AI scans used: 42 / 500 this month" widget whenever that's wanted.
router.get('/usage', async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;

    const { data: org, error: orgError } = await req.userClient
      .from('organizations')
      .select('vision_scan_limit')
      .eq('id', orgId)
      .maybeSingle();

    if (orgError) throw orgError;

    const { count, error: countError } = await req.userClient
      .from('vision_usage')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .gte('created_at', startOfCurrentMonth());

    if (countError) throw countError;

    res.json({ used: count || 0, limit: org?.vision_scan_limit ?? null });
  } catch (err) { next(err); }
});

module.exports = router;
