const express  = require('express');
const router   = express.Router();
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

// POST /api/asset-catalog — create a new reusable catalog item.
//
// CRITICAL FIX: organization_id was never set on this insert, which has
// been silently broken since Phase 1 made that column NOT NULL. This
// was invisible in the UI because AssetsTab calls this endpoint with
// .catch(() => {}) — every "save as reusable catalog entry" has been
// failing silently since Phase 1 shipped. Also switched to req.userClient.
router.post('/', requireRole('admin', 'staff'), async (req, res, next) => {
  try {
    const { name, category, default_notes } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const { data, error } = await req.userClient
      .from('asset_catalog')
      .insert({
        name, category, default_notes,
        created_by: req.user.id,
        organization_id: req.user.organization_id,
      })
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

// DELETE /api/asset-catalog/:id — admin only. Switched to req.userClient
// so this can only affect a catalog item in the caller's org.
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { error } = await req.userClient.from('asset_catalog').delete().eq('id', req.params.id);
    if (error) throw error;
    res.status(204).send();
  } catch (err) { next(err); }
});

// PATCH /api/asset-catalog/:id — update a catalog item, including
// total_quantity (how many of this item the org actually owns — used
// by the availability check below). Nothing else in the app required
// this before; catalog items could previously only be created or
// deleted, never edited.
router.patch('/:id', requireRole('admin', 'staff'), async (req, res, next) => {
  try {
    const allowed = ['name', 'category', 'default_notes', 'total_quantity'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    const { data, error } = await req.userClient
      .from('asset_catalog')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .maybeSingle();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: `An asset named "${updates.name}" already exists in the catalog` });
      }
      throw error;
    }
    if (!data) return res.status(404).json({ error: 'Catalog item not found' });
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/asset-catalog/:id/availability?quantity=N&ship_by_date=YYYY-MM-DD&return_by_date=YYYY-MM-DD&exclude_booth_asset_id=
//
// Checks whether booking `quantity` units of this catalog item for the
// given date window would exceed how many the org actually owns, given
// everything else already booked with an overlapping window. Only
// meaningful for catalog items that have total_quantity set — items
// without it are treated as "not tracked," since there's nothing to
// check against.
//
// This is advisory, not a hard block — the caller (frontend) decides
// what to do with the result. exclude_booth_asset_id lets an edit to an
// existing booking check without conflicting against itself.
router.get('/:id/availability', async (req, res, next) => {
  try {
    const { quantity, ship_by_date, return_by_date, exclude_booth_asset_id } = req.query;
    const requestedQty = parseInt(quantity, 10) || 1;

    const { data: catalogItem, error: catalogError } = await req.userClient
      .from('asset_catalog')
      .select('id, name, total_quantity')
      .eq('id', req.params.id)
      .maybeSingle();

    if (catalogError) throw catalogError;
    if (!catalogItem) return res.status(404).json({ error: 'Catalog item not found' });

    if (catalogItem.total_quantity == null) {
      return res.json({ tracked: false, name: catalogItem.name });
    }

    if (!ship_by_date || !return_by_date) {
      return res.json({
        tracked: true,
        name: catalogItem.name,
        total_quantity: catalogItem.total_quantity,
        would_exceed: false,
        note: 'Both ship and return dates are needed to check availability',
      });
    }

    // Two date ranges overlap if each one starts on or before the other
    // ends. Only bookings that actually have both dates set can be
    // compared this way — anything missing a date is skipped rather
    // than guessed at.
    let query = req.userClient
      .from('booth_assets')
      .select('id, conference_id, quantity, ship_by_date, return_by_date, conferences(name)')
      .eq('catalog_id', req.params.id)
      .not('ship_by_date', 'is', null)
      .not('return_by_date', 'is', null)
      .lte('ship_by_date', return_by_date)
      .gte('return_by_date', ship_by_date);

    if (exclude_booth_asset_id) query = query.neq('id', exclude_booth_asset_id);

    const { data: overlapping, error: overlapError } = await query;
    if (overlapError) throw overlapError;

    const committedElsewhere = overlapping.reduce((sum, b) => sum + (b.quantity || 0), 0);
    const available = catalogItem.total_quantity - committedElsewhere;

    res.json({
      tracked: true,
      name: catalogItem.name,
      total_quantity: catalogItem.total_quantity,
      committed_elsewhere: committedElsewhere,
      available,
      would_exceed: requestedQty > available,
      conflicts: overlapping.map(b => ({
        conference_id: b.conference_id,
        conference_name: b.conferences?.name || null,
        quantity: b.quantity,
        ship_by_date: b.ship_by_date,
        return_by_date: b.return_by_date,
      })),
    });
  } catch (err) { next(err); }
});

module.exports = router;
