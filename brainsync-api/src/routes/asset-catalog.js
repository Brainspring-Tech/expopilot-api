const express  = require('express');
const router   = express.Router();
const supabase = require('../services/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/asset-catalog?search=banner
router.get('/', async (req, res, next) => {
  try {
    let query = req.userClient
      .from('asset_catalog')
      .select('*')
      .order('name');

    if (req.query.search) {
      query = query.ilike('name', `%${req.query.search}%`);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/asset-catalog — create a new reusable catalog item
router.post('/', requireRole('admin', 'staff'), async (req, res, next) => {
  try {
    const { name, category, default_notes } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const { data, error } = await supabase
      .from('asset_catalog')
      .insert({ name, category, default_notes, created_by: req.user.id })
      .select()
      .single();

    if (error) {
      // unique index on lower(name) — surface a friendly message instead of a raw constraint error
      if (error.code === '23505') {
        return res.status(409).json({ error: `An asset named "${name}" already exists in the catalog` });
      }
      throw error;
    }
    res.status(201).json(data);
  } catch (err) { next(err); }
});

// DELETE /api/asset-catalog/:id — admin only
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { error } = await supabase.from('asset_catalog').delete().eq('id', req.params.id);
    if (error) throw error;
    res.status(204).send();
  } catch (err) { next(err); }
});

module.exports = router;
