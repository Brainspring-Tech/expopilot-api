const express  = require('express');
const router   = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const { sendShiftCalendarInvite } = require('../services/email');
const { notifyIfEnabled } = require('../services/notifications');

router.use(requireAuth);

// GET /api/shifts?conference_id=xxx&user_id=xxx
// Admins can filter by any user_id (e.g. the admin console's per-conference
// shift schedule, which lists everyone). Everyone else — staff,
// lead_capture, viewer — can only ever get their OWN shifts, regardless of
// what user_id (if any) is passed. This is an explicit ownership check
// rather than relying on RLS alone, matching the pattern already used in
// users.js and staff_assignments routes. With no conference_id given, this
// also now doubles as "my schedule across every conference" for the PWA.
router.get('/', async (req, res, next) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const effectiveUserId = isAdmin ? req.query.user_id : req.user.id;

    let query = req.userClient
      .from('staff_shifts')
      .select('*, users!staff_shifts_user_id_fkey(full_name), conferences(name, venue, city, state, start_date, end_date)')
      .order('shift_date', { ascending: true })
      .order('start_time', { ascending: true });

    if (req.query.conference_id) query = query.eq('conference_id', req.query.conference_id);
    if (effectiveUserId)         query = query.eq('user_id', effectiveUserId);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/shifts — admin only. Switched both the assignment lookup
// and the insert to req.userClient. Previously, both used the
// service-role client with no organization check — an admin could
// reference a conference_id/user_id pair from another org entirely and
// the assignment-lookup guard below wouldn't have caught it.
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
    const { data: assignment, error: assignmentError } = await req.userClient
      .from('staff_assignments')
      .select('id')
      .eq('conference_id', conference_id)
      .eq('user_id', user_id)
      .maybeSingle();

    if (assignmentError) throw assignmentError;
    if (!assignment) {
      return res.status(400).json({ error: 'This person is not assigned to this conference yet' });
    }

    const { data, error } = await req.userClient
      .from('staff_shifts')
      .insert({ conference_id, user_id, shift_date, start_time, end_time, notes, created_by: req.user.id })
      .select('*, users!staff_shifts_user_id_fkey(full_name)')
      .single();

    if (error) throw error;
    res.status(201).json(data);

    const { data: conf } = await req.userClient
      .from('conferences')
      .select('name, venue, timezone')
      .eq('id', conference_id)
      .single();

    notifyIfEnabled(user_id, 'shift_calendar_invite', recipient => sendShiftCalendarInvite({
      shiftId: data.id,
      staffEmail: recipient.email,
      staffName: recipient.full_name,
      conferenceName: conf?.name || 'a conference',
      venue: conf?.venue,
      shiftDate: shift_date,
      startTime: start_time,
      endTime: end_time,
      timezone: conf?.timezone || 'America/Chicago',
    }));
  } catch (err) { next(err); }
});

// PATCH /api/shifts/:id — admin only. Switched to req.userClient so
// this can only affect a shift in the caller's org.
router.patch('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const allowed = ['shift_date', 'start_time', 'end_time', 'notes'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    if (updates.start_time && updates.end_time && updates.end_time <= updates.start_time) {
      return res.status(400).json({ error: 'end_time must be after start_time' });
    }

    const { data, error } = await req.userClient
      .from('staff_shifts')
      .update(updates)
      .eq('id', req.params.id)
      .select('*, users!staff_shifts_user_id_fkey(full_name)')
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Shift not found' });
    res.json(data);
  } catch (err) { next(err); }
});

// DELETE /api/shifts/:id — admin only. Switched to req.userClient so
// this can only affect a shift in the caller's org.
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { error } = await req.userClient.from('staff_shifts').delete().eq('id', req.params.id);
    if (error) throw error;
    res.status(204).send();
  } catch (err) { next(err); }
});

module.exports = router;
