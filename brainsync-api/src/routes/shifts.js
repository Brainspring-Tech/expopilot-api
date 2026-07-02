const express  = require('express');
const router   = express.Router();
const supabase = require('../services/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/shifts?conference_id=xxx — list shifts for a conference
router.get('/', async (req, res, next) => {
  try {
    let query = req.userClient
      .from('staff_shifts')
      .select('*, users(full_name)')
      .order('shift_date', { ascending: true })
      .order('start_time', { ascending: true });

    if (req.query.conference_id) query = query.eq('conference_id', req.query.conference_id);
    if (req.query.user_id)       query = query.eq('user_id', req.query.user_id);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/shifts — admin only
router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { conference_id, user_id, shift_date, start_time, end_time, notes } = req.body;
    if (!conference_id || !user_id || !shift_date || !start_time || !end_time) {
      return res.status(400).json({ error: 'conference_id, user_id, shift_date, start_time, and end_time are required' });
    }
    if (end_time <= start_time) {
      return res.status(400).json({ error: 'end_time must be after start_time' });
    }

    // A shift can only be scheduled for someone already assigned to the conference
    const { data: assignment, error: assignmentError } = await supabase
      .from('staff_assignments')
      .select('id')
      .eq('conference_id', conference_id)
      .eq('user_id', user_id)
      .maybeSingle();

    if (assignmentError) throw assignmentError;
    if (!assignment) {
      return res.status(400).json({ error: 'This person is not assigned to this conference yet' });
    }

    const { data, error } = await supabase
      .from('staff_shifts')
      .insert({ conference_id, user_id, shift_date, start_time, end_time, notes, created_by: req.user.id })
      .select('*, users(full_name)')
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

// PATCH /api/shifts/:id — admin only
router.patch('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const allowed = ['shift_date', 'start_time', 'end_time', 'notes'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    if (updates.start_time && updates.end_time && updates.end_time <= updates.start_time) {
      return res.status(400).json({ error: 'end_time must be after start_time' });
    }

    const { data, error } = await supabase
      .from('staff_shifts')
      .update(updates)
      .eq('id', req.params.id)
      .select('*, users(full_name)')
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// DELETE /api/shifts/:id — admin only
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { error } = await supabase.from('staff_shifts').delete().eq('id', req.params.id);
    if (error) throw error;
    res.status(204).send();
  } catch (err) { next(err); }
});

module.exports = router;
