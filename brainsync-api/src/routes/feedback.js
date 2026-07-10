const express  = require('express');
const router   = express.Router();
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

const VALID_TYPES = ['bug', 'idea', 'question', 'praise'];
// PWA areas (leads/conferences/prep/dashboard/other) + admin console
// areas (assets/tasks/expenses/roi/users/settings/prospects/platform) —
// see the "expand feedback areas" migration for the matching DB constraint.
const VALID_AREAS = [
  'leads', 'conferences', 'prep', 'dashboard', 'other',
  'assets', 'tasks', 'expenses', 'roi', 'users', 'settings', 'prospects', 'platform',
];

// POST /api/feedback — any authenticated user, from the PWA's feedback
// widget. organization_id and user_id always come from the session
// (req.user), never from the request body — the client can't spoof
// which org/user a submission is attributed to.
router.post('/', async (req, res, next) => {
  try {
    const { type, area, message, rating, contact_ok, contact_email, page_url, app_version, user_agent } = req.body;

    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
    }
    if (!VALID_AREAS.includes(area)) {
      return res.status(400).json({ error: `area must be one of: ${VALID_AREAS.join(', ')}` });
    }
    if (rating != null && (rating < 1 || rating > 5)) {
      return res.status(400).json({ error: 'rating must be between 1 and 5' });
    }

    const { data, error } = await req.userClient
      .from('feedback')
      .insert({
        organization_id: req.user.organization_id,
        user_id: req.user.id,
        type,
        area,
        message: message || null,
        rating: rating ?? null,
        contact_ok: !!contact_ok,
        contact_email: contact_ok ? (contact_email || null) : null,
        page_url: page_url || null,
        app_version: app_version || null,
        user_agent: user_agent || null,
      })
      .select('id')
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

module.exports = router;
