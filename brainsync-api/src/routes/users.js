const express  = require('express');
const router   = express.Router();
const supabase = require('../services/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/users/me — current user profile
router.get('/me', async (req, res) => {
  res.json(req.user);
});

// GET /api/users — admin: list all staff in the caller's organization.
// Switched to req.userClient so RLS ("users: admin read all") scopes
// this to the caller's own org — previously used the service-role
// client and returned every user across every organization.
router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { data, error } = await req.userClient
      .from('users')
      .select('id, full_name, email, role, created_at')
      .order('full_name');

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/users — admin: create a new user (auth + profile row) in
// the caller's organization.
router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { email, password, full_name, role } = req.body;

    if (!email || !password || !full_name) {
      return res.status(400).json({ error: 'email, password, and full_name are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    // lead_capture: PWA-only role, hard-blocked from the admin console
    // (see App.jsx). Lets an org give someone lead-capture access on the
    // mobile app without ever exposing the admin tooling to them.
    const validRoles = ['admin', 'staff', 'viewer', 'lead_capture'];
    const assignedRole = validRoles.includes(role) ? role : 'staff';

    // The handle_new_user() trigger reads organization_id from this
    // metadata to set it on the new profile row — the new user inherits
    // the creating admin's organization. Without this, the trigger's
    // insert into public.users fails (organization_id is NOT NULL).
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name, organization_id: req.user.organization_id },
    });

    if (authError) {
      if (authError.message?.includes('already been registered')) {
        return res.status(409).json({ error: 'A user with this email already exists' });
      }
      throw authError;
    }

    if (assignedRole !== 'staff') {
      await supabase
        .from('users')
        .update({ role: assignedRole })
        .eq('auth_id', authData.user.id);
    }

    const { data: profile, error: profileError } = await supabase
      .from('users')
      .select('id, full_name, email, role, created_at')
      .eq('auth_id', authData.user.id)
      .single();

    if (profileError) throw profileError;

    res.status(201).json(profile);
  } catch (err) { next(err); }
});

// PATCH /api/users/:id/role — admin: change a role. Switched to
// req.userClient so RLS ("users: admin write") only allows this to
// affect a user in the caller's own organization.
router.patch('/:id/role', requireRole('admin'), async (req, res, next) => {
  try {
    const { role } = req.body;
    const valid = ['admin', 'staff', 'viewer', 'lead_capture'];
    if (!valid.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${valid.join(', ')}` });
    }

    const { data, error } = await req.userClient
      .from('users')
      .update({ role })
      .eq('id', req.params.id)
      .select('id, full_name, email, role')
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'User not found' });
    res.json(data);
  } catch (err) { next(err); }
});

// DELETE /api/users/:id — admin: remove a user's access. Switched to
// req.userClient so this can only ever target a user in the caller's
// own organization — previously used the service-role client with no
// organization check at all.
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { data: userRow, error: lookupError } = await req.userClient
      .from('users')
      .select('auth_id')
      .eq('id', req.params.id)
      .maybeSingle();

    if (lookupError) throw lookupError;
    if (!userRow) return res.status(404).json({ error: 'User not found' });

    // Always remove the profile row — this is what actually gates access
    // throughout the app (RLS, role checks, etc).
    const { error: deleteError } = await req.userClient
      .from('users')
      .delete()
      .eq('id', req.params.id);

    if (deleteError) throw deleteError;

    // Best-effort: also remove the underlying auth identity so they can't
    // log in at all. If this fails, the profile row is already gone, so
    // they're effectively locked out regardless — log it, don't fail.
    if (userRow?.auth_id) {
      const { error: authDeleteError } = await supabase.auth.admin.deleteUser(userRow.auth_id);
      if (authDeleteError) {
        console.warn(`[users] auth.admin.deleteUser failed for ${userRow.auth_id}:`, authDeleteError.message);
      }
    }

    res.status(204).send();
  } catch (err) { next(err); }
});

// POST /api/users/assign — assign staff to a conference. Both the
// conference and the target user must belong to the caller's org.
// RLS on staff_assignments already constrains conference_id to the
// caller's org, but doesn't check the assigned user's org — so we
// verify that explicitly here before allowing the assignment.
router.post('/assign', requireRole('admin'), async (req, res, next) => {
  try {
    const { conference_id, user_id, role, shift_notes } = req.body;
    if (!conference_id || !user_id) {
      return res.status(400).json({ error: 'conference_id and user_id are required' });
    }

    const { data: targetUser, error: targetUserError } = await req.userClient
      .from('users')
      .select('id')
      .eq('id', user_id)
      .maybeSingle();

    if (targetUserError) throw targetUserError;
    if (!targetUser) {
      return res.status(400).json({ error: 'That user is not in your organization' });
    }

    const { data, error } = await req.userClient
      .from('staff_assignments')
      .upsert({ conference_id, user_id, role: role || 'booth staff', shift_notes },
               { onConflict: 'conference_id,user_id' })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

// DELETE /api/users/assign — remove staff from conference. Switched to
// req.userClient so RLS constrains this to the caller's own org.
router.delete('/assign', requireRole('admin'), async (req, res, next) => {
  try {
    const { conference_id, user_id } = req.body;
    const { error } = await req.userClient
      .from('staff_assignments')
      .delete()
      .eq('conference_id', conference_id)
      .eq('user_id', user_id);

    if (error) throw error;
    res.status(204).send();
  } catch (err) { next(err); }
});

// PATCH /api/users/assign/:id — update travel/lodging info. Switched to
// req.userClient so RLS constrains this to assignments belonging to
// conferences in the caller's own org.
router.patch('/assign/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const allowed = ['arrival_date', 'departure_date', 'arrival_flight', 'departure_flight',
                      'hotel_name', 'hotel_confirmation', 'travel_notes'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    const { data, error } = await req.userClient
      .from('staff_assignments')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Staff assignment not found' });
    res.json(data);
  } catch (err) { next(err); }
});

module.exports = router;
