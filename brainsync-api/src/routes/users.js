const express  = require('express');
const router   = express.Router();
const supabase = require('../services/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/users/me — current user profile
router.get('/me', async (req, res) => {
  res.json(req.user);
});

// GET /api/users — admin: list all staff
router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, full_name, email, role, created_at')
      .order('full_name');

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// PATCH /api/users/:id/role — admin: change user role
router.patch('/:id/role', requireRole('admin'), async (req, res, next) => {
  try {
    const { role } = req.body;
    const valid = ['admin', 'staff', 'viewer'];
    if (!valid.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${valid.join(', ')}` });
    }

    const { data, error } = await supabase
      .from('users')
      .update({ role })
      .eq('id', req.params.id)
      .select('id, full_name, email, role')
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/users/assign — assign staff to a conference
router.post('/assign', requireRole('admin'), async (req, res, next) => {
  try {
    const { conference_id, user_id, role, shift_notes } = req.body;
    if (!conference_id || !user_id) {
      return res.status(400).json({ error: 'conference_id and user_id are required' });
    }

    const { data, error } = await supabase
      .from('staff_assignments')
      .upsert({ conference_id, user_id, role: role || 'booth staff', shift_notes },
               { onConflict: 'conference_id,user_id' })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

// DELETE /api/users/assign — remove staff from conference
router.delete('/assign', requireRole('admin'), async (req, res, next) => {
  try {
    const { conference_id, user_id } = req.body;
    const { error } = await supabase
      .from('staff_assignments')
      .delete()
      .eq('conference_id', conference_id)
      .eq('user_id', user_id);

    if (error) throw error;
    res.status(204).send();
  } catch (err) { next(err); }
});

module.exports = router;
