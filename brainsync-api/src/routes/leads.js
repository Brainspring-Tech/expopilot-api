const express  = require('express');
const router   = express.Router();
const supabase = require('../services/supabase');
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

// POST /api/leads — single lead capture (online)
router.post('/', async (req, res, next) => {
  try {
    const lead = buildLeadPayload(req.body, req.user.id);
    if (!lead.conference_id) {
      return res.status(400).json({ error: 'conference_id is required' });
    }

    const { data, error } = await supabase
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

// POST /api/leads/batch — offline batch upload from PWA
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

    const { data, error } = await supabase
      .from('leads')
      .insert(rows)
      .select('id');

    if (error) throw error;

    // Queue HubSpot sync for all inserted leads
    data.forEach(({ id }) => queueHubSpotSync(id).catch(console.error));

    res.status(201).json({ inserted: data.length, ids: data.map(d => d.id) });
  } catch (err) { next(err); }
});

// PATCH /api/leads/:id — update score, notes, tags
router.patch('/:id', async (req, res, next) => {
  try {
    const allowed = ['first_name','last_name','email','phone','organization','title',
                     'grade_levels','interest_tags','score','notes'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    const { data, error } = await supabase
      .from('leads')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/leads/:id/interactions — log a touchpoint
router.post('/:id/interactions', async (req, res, next) => {
  try {
    const { interaction_type, notes } = req.body;
    const { data, error } = await supabase
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

// POST /api/leads/:id/follow-ups — create a follow-up task
router.post('/:id/follow-ups', async (req, res, next) => {
  try {
    const { action, assigned_to, due_date, notes } = req.body;
    if (!action) return res.status(400).json({ error: 'action is required' });

    const { data, error } = await supabase
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
