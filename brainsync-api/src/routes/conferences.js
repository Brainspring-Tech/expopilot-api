const express = require('express');
const router  = express.Router();
const supabase = require('../services/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/conferences — list all (admin) or assigned (staff)
router.get('/', async (req, res, next) => {
  try {
    const client = req.userClient;
    const { data, error } = await client
      .from('conferences')
      .select('*')
      .order('start_date', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/conferences/roi — ROI summary view
router.get('/roi', async (req, res, next) => {
  try {
    const { data, error } = await req.userClient
      .from('conference_roi_summary')
      .select('*')
      .order('start_date', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/conferences/:id — single conference with staff + asset counts
router.get('/:id', async (req, res, next) => {
  try {
    const { data, error } = await req.userClient
      .from('conferences')
      .select(`
        *,
        staff_assignments ( id, role, user_id, users(full_name, email) ),
        booth_assets ( id, name, category, status, quantity ),
        tasks ( id, title, phase, status, due_date ),
        conference_budgets ( category, budgeted, actual )
      `)
      .eq('id', req.params.id)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Conference not found' });
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/conferences — admin only
router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { name, venue, city, state, start_date, end_date, budget, notes } = req.body;
    if (!name || !start_date || !end_date) {
      return res.status(400).json({ error: 'name, start_date, and end_date are required' });
    }

    const { data, error } = await supabase
      .from('conferences')
      .insert({ name, venue, city, state, start_date, end_date, budget, notes, created_by: req.user.id })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

// PATCH /api/conferences/:id — admin only
router.patch('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const allowed = ['name','venue','city','state','start_date','end_date','budget','status','notes','hubspot_deal_id'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    const { data, error } = await supabase
      .from('conferences')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// DELETE /api/conferences/:id — admin only
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { error } = await supabase
      .from('conferences')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.status(204).send();
  } catch (err) { next(err); }
});

// POST /api/conferences/:id/budget — upsert budget line items
router.post('/:id/budget', requireRole('admin'), async (req, res, next) => {
  try {
    const { items } = req.body; // [{ category, budgeted, actual, notes }]
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'items must be an array' });
    }

    const rows = items.map(i => ({ ...i, conference_id: req.params.id }));
    const { data, error } = await supabase
      .from('conference_budgets')
      .upsert(rows, { onConflict: 'conference_id,category' })
      .select();

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

module.exports = router;
