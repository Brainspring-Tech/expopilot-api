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

// POST /api/users — admin: create a new user (auth + profile row)
router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { email, password, full_name, role } = req.body;

    if (!email || !password || !full_name) {
      return res.status(400).json({ error: 'email, password, and full_name are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const validRoles = ['admin', 'staff', 'viewer'];
    const assignedRole = validRoles.includes(role) ? role : 'staff';

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name },
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

// DELETE /api/users/:id — admin: remove a user's access
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { data: userRow, error: lookupError } = await supabase
      .from('users')
      .select('auth_id')
      .eq('id', req.params.id)
      .single();

    if (lookupError) throw lookupError;

    // Always remove the profile row — this is what actually gates access
    // throughout the app (RLS, role checks, etc).
    const { error: deleteError } = await supabase
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