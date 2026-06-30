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
    const { conference_id, catalog_id, name, category, quantity, ship_by_date, return_by_date, notes } = req.body;

    let resolvedName = name;
    let resolvedCategory = category;
    let resolvedNotes = notes;

    if (catalog_id) {
      const { data: catalogItem, error: catalogError } = await supabase
        .from('asset_catalog')
        .select('name, category, default_notes')
        .eq('id', catalog_id)
        .single();

      if (catalogError || !catalogItem) {
        return res.status(400).json({ error: 'catalog_id does not match any asset in the catalog' });
      }

      // Catalog is the source of truth for name/category/notes when an item is selected
      resolvedName = catalogItem.name;
      resolvedCategory = catalogItem.category;
      resolvedNotes = notes || catalogItem.default_notes;
    }

    if (!conference_id || !resolvedName) {
      return res.status(400).json({ error: 'conference_id and name are required' });
    }

    const { data, error } = await supabase
      .from('booth_assets')
      .insert({
        conference_id,
        catalog_id: catalog_id || null,
        name: resolvedName,
        category: resolvedCategory,
        quantity: quantity || 1,
        ship_by_date,
        return_by_date,
        notes: resolvedNotes,
      })
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
