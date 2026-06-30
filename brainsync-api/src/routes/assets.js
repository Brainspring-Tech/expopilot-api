const express  = require('express');
const router   = express.Router();
const supabase = require('../services/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/assets?conference_id=xxx
router.get('/', async (req, res, next) => {
  try {
    let query = req.userClient
      .from('booth_assets')
      .select('*')
      .order('category')
      .order('name');

    if (req.query.conference_id) query = query.eq('conference_id', req.query.conference_id);
    if (req.query.status)        query = query.eq('status', req.query.status);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/assets
router.post('/', async (req, res, next) => {
  try {
    const { conference_id, name, category, quantity, ship_by_date, return_by_date, notes } = req.body;
    if (!conference_id || !name) {
      return res.status(400).json({ error: 'conference_id and name are required' });
    }

    const { data, error } = await supabase
      .from('booth_assets')
      .insert({ conference_id, name, category, quantity: quantity || 1, ship_by_date, return_by_date, notes })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

// PATCH /api/assets/:id — update status, tracking, etc.
router.patch('/:id', async (req, res, next) => {
  try {
    const allowed = ['name','category','quantity','status','shipping_carrier','tracking_number',
                     'ship_by_date','return_by_date','notes'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    const { data, error } = await supabase
      .from('booth_assets')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// DELETE /api/assets/:id — admin only
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { error } = await supabase.from('booth_assets').delete().eq('id', req.params.id);
    if (error) throw error;
    res.status(204).send();
  } catch (err) { next(err); }
});

module.exports = router;
