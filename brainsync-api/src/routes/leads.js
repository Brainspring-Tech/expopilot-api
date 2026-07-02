const express  = require('express');
const router   = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const { queueHubSpotSync } = require('../services/hubspot');

router.use(requireAuth);

// GET /api/leads?conference_id=xxx&score=4&synced=false
router.get('/', async (req, res, next) => {
  try {
    let query = req.userClient
      .from('leads')
      .select(`
        *,
        conferences ( name, city, state ),
        users!leads_captured_by_fkey ( full_name )
      `)
      .order('captured_at', { ascending: false });

    if (req.query.conference_id) query = query.eq('conference_id', req.query.conference_id);
    if (req.query.score)         query = query.gte('score', parseInt(req.query.score));
    if (req.query.synced === 'false') query = query.eq('synced_to_hubspot', false);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/leads/:id — single lead with interactions and follow-ups
router.get('/:id', async (req, res, next) => {
  try {
    const { data, error } = await req.userClient
      .from('leads')
      .select(`
        *,
        interactions ( *, users!interactions_staff_id_fkey(full_name) ),
        follow_up_tasks ( *, users!follow_up_tasks_assigned_to_fkey(full_name) )
      `)
      .eq('id', req.params.id)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Lead not found' });
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/leads — single lead capture (online). Switched to
// req.userClient so RLS ("leads: staff capture" / "leads: admin all")
// enforces that conference_id actually belongs to the caller's org
// (and, for staff, that they're assigned to it) — previously used the
// service-role client with no check at all.
router.post('/', async (req, res, next) => {
  try {
    const lead = buildLeadPayload(req.body, req.user.id);
    if (!lead.conference_id) {
      return res.status(400).json({ error: 'conference_id is required' });
    }

    // Friendlier error than a raw RLS violation if the conference
    // doesn't exist or isn't in the caller's organization at all.
    const { data: conf, error: confError } = await req.userClient
      .from('conferences')
      .select('id')
      .eq('id', lead.conference_id)
      .maybeSingle();

    if (confError) throw confError;
    if (!conf) return res.status(400).json({ error: 'Conference not found' });

    const { data, error } = await req.userClient
      .from('leads')
      .insert(lead)
      .select()
      .single();

    if (error) throw error;

    // Fire-and-forget HubSpot sync
    queueHubSpotSync(data.id).catch(e => console.error('[hubspot queue]', e.message));

    res.status(201).json(data);
  } catch (err) { next(err); }
});

// POST /api/leads/batch — offline batch upload from PWA. Switched to
// req.userClient — RLS enforces each row's conference_id the same way
// as a single capture; if any row in the batch targets a conference
// outside the caller's org or assignment, the whole batch insert fails
// atomically rather than partially succeeding.
router.post('/batch', async (req, res, next) => {
  try {
    const { leads } = req.body;
    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: 'leads array is required' });
    }
    if (leads.length > 200) {
      return res.status(400).json({ error: 'Max 200 leads per batch' });
    }

    const rows = leads.map(l => buildLeadPayload(l, req.user.id));

    const { data, error } = await req.userClient
      .from('leads')
      .insert(rows)
      .select('id');

    if (error) throw error;

    // Queue HubSpot sync for all inserted leads
    data.forEach(({ id }) => queueHubSpotSync(id).catch(console.error));

    res.status(201).json({ inserted: data.length, ids: data.map(d => d.id) });
  } catch (err) { next(err); }
});

// PATCH /api/leads/:id — update score, notes, tags. Switched to
// req.userClient so this can only affect a lead the caller can actually
// see under RLS (their org, and for staff, only leads they captured) —
// previously used the service-role client with no check at all, meaning
// any staff member could edit any lead across any conference or org.
router.patch('/:id', async (req, res, next) => {
  try {
    const allowed = ['first_name','last_name','email','phone','organization','title',
                     'grade_levels','interest_tags','score','notes'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    const { data, error } = await req.userClient
      .from('leads')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Lead not found' });
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/leads/:id/interactions — log a touchpoint. Switched to
// req.userClient with an explicit lead-existence check first, so a
// cross-tenant lead id returns a clean 404 instead of a raw RLS error.
router.post('/:id/interactions', async (req, res, next) => {
  try {
    const { data: lead, error: leadError } = await req.userClient
      .from('leads')
      .select('id')
      .eq('id', req.params.id)
      .maybeSingle();

    if (leadError) throw leadError;
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const { interaction_type, notes } = req.body;
    const { data, error } = await req.userClient
      .from('interactions')
      .insert({
        lead_id: req.params.id,
        staff_id: req.user.id,
        interaction_type: interaction_type || 'booth_visit',
        notes,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

// POST /api/leads/:id/follow-ups — create a follow-up task. Same
// pattern as interactions above.
router.post('/:id/follow-ups', async (req, res, next) => {
  try {
    const { data: lead, error: leadError } = await req.userClient
      .from('leads')
      .select('id')
      .eq('id', req.params.id)
      .maybeSingle();

    if (leadError) throw leadError;
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const { action, assigned_to, due_date, notes } = req.body;
    if (!action) return res.status(400).json({ error: 'action is required' });

    const { data, error } = await req.userClient
      .from('follow_up_tasks')
      .insert({
        lead_id: req.params.id,
        assigned_to: assigned_to || req.user.id,
        action,
        due_date,
        notes,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

// ── Helpers ──────────────────────────────────────────────────

function buildLeadPayload(body, capturedBy) {
  return {
    conference_id:   body.conference_id,
    captured_by:     capturedBy,
    first_name:      body.first_name,
    last_name:       body.last_name,
    email:           body.email,
    phone:           body.phone,
    organization:    body.organization,
    title:           body.title,
    grade_levels:    body.grade_levels   || [],
    interest_tags:   body.interest_tags  || [],
    score:           body.score          || 3,
    notes:           body.notes,
    badge_scan_data: body.badge_scan_data || null,
    captured_at:     body.captured_at    || new Date().toISOString(),
  };
}

module.exports = router;
