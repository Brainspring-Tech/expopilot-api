const express  = require('express');
const router   = express.Router();
const supabase = require('../services/supabase');
const { requireAuth, requireRole, blockApiKey } = require('../middleware/auth');

router.use(requireAuth);
// User management (invite/delete/role changes, including this org's own
// shadow-user bookkeeping for API keys) is never reachable via an API
// key, regardless of its permission level — same reasoning as
// apiKeys.js's own blockApiKey guard.
router.use(blockApiKey);

// GET /api/users/me — current user profile
router.get('/me', async (req, res) => {
  res.json(req.user);
});

// PATCH /api/users/me/activate — called by the set-password page right
// after supabase.auth.updateUser({ password }) succeeds, so the invite
// no longer shows as "pending" in the admin's Users list. Idempotent —
// safe to call even if already active.
router.patch('/me/activate', async (req, res, next) => {
  try {
    const { data, error } = await req.userClient
      .from('users')
      .update({ status: 'active' })
      .eq('id', req.user.id)
      .select('id, status')
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// PATCH /api/users/me — self-serve profile update. Deliberately does NOT
// allow role or email here — email changes go through Supabase Auth's
// own verified-email-change flow, not this endpoint, and role is admin-
// only (see PATCH /:id/role below).
router.patch('/me', async (req, res, next) => {
  try {
    const allowed = ['full_name', 'job_title', 'phone', 'avatar_url'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    const { data, error } = await req.userClient
      .from('users')
      .update(updates)
      .eq('id', req.user.id)
      .select('id, full_name, email, role, job_title, phone, avatar_url')
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// PATCH /api/users/:id/profile — admin: update profile fields for
// someone else in the same org (e.g. onboarding a new hire's job title
// and photo for them). Never touches role — that stays on the
// dedicated /:id/role route. req.userClient + RLS scopes this to the
// caller's own org already; the explicit organization_id check below is
// defense-in-depth, matching the pattern used elsewhere in this file.
router.patch('/:id/profile', requireRole('admin'), async (req, res, next) => {
  try {
    const { data: targetUser, error: targetError } = await req.userClient
      .from('users')
      .select('id, organization_id')
      .eq('id', req.params.id)
      .maybeSingle();

    if (targetError) throw targetError;
    if (!targetUser) return res.status(404).json({ error: 'User not found' });
    if (targetUser.organization_id !== req.user.organization_id) {
      return res.status(403).json({ error: 'That user is not in your organization' });
    }

    const allowed = ['full_name', 'job_title', 'phone', 'avatar_url'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    const { data, error } = await req.userClient
      .from('users')
      .update(updates)
      .eq('id', req.params.id)
      .select('id, full_name, email, role, job_title, phone, avatar_url')
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/users/:id/contact — the "click a name, see their contact
// card" lookup. Any authenticated org member can look up any coworker's
// card (by design — see the "users: org member read directory" RLS
// policy), not just admins. Explicit organization_id check here as
// defense-in-depth, same pattern as elsewhere in this file, even though
// RLS should already prevent cross-org reads.
router.get('/:id/contact', async (req, res, next) => {
  try {
    const { data, error } = await req.userClient
      .from('users')
      .select('id, full_name, email, role, job_title, phone, avatar_url, organization_id')
      .eq('id', req.params.id)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'User not found' });
    if (data.organization_id !== req.user.organization_id) {
      return res.status(403).json({ error: 'That user is not in your organization' });
    }

    const { organization_id, ...contact } = data;
    res.json(contact);
  } catch (err) { next(err); }
});

// GET /api/users/directory — lightweight org roster for assignment
// pickers (e.g. the Staff tab's "add staff" dropdown). Open to any
// authenticated org member, not just admins — RLS ("users: org member
// read directory") already permits reading a coworker's row one at a
// time via the contact-card lookup (including email), so this doesn't
// expose anything that wasn't already readable, just in bulk. Still
// excludes phone/job_title — full detail requires the admin-only list
// below or the single-row /:id/contact lookup.
router.get('/directory', async (req, res, next) => {
  try {
    const { data, error } = await req.userClient
      .from('users')
      .select('id, full_name, email, role, avatar_url')
      .order('full_name');

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/users — admin: list all staff in the caller's organization.
// Includes `status` ('invited' | 'active') so the UI can show a pending
// badge and offer a resend-invite action.
router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { data, error } = await req.userClient
      .from('users')
      .select('id, full_name, email, role, status, created_at, job_title, phone, avatar_url')
      .order('full_name');

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/users — admin: invite a new user into the caller's
// organization. No password is set here — Supabase sends the branded
// "Invite user" email (custom SMTP via Resend) with a link that lets the
// invitee set their own password on either the admin console or PWA's
// set-password page, depending on role. See POST /:id/resend-invite for
// re-sending an expired/unactioned invite.
router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { email, full_name, role } = req.body;

    if (!email || !full_name) {
      return res.status(400).json({ error: 'email and full_name are required' });
    }

    // lead_capture: PWA-only role, hard-blocked from the admin console
    // (see App.jsx). Lets an org give someone lead-capture access on the
    // mobile app without ever exposing the admin tooling to them.
    const validRoles = ['admin', 'staff', 'viewer', 'lead_capture'];
    const assignedRole = validRoles.includes(role) ? role : 'staff';

    const { data: org, error: orgError } = await req.userClient
      .from('organizations')
      .select('seat_limit, name')
      .eq('id', req.user.organization_id)
      .single();

    if (orgError) throw orgError;

    // Seat limit check. lead_capture is deliberately excluded — it's a
    // PWA-only role with a different usage pattern than an admin-console
    // seat (mirrors how it's already excluded from other admin-console
    // gating elsewhere in this app). A null seat_limit means unlimited,
    // same convention as vision_scan_limit on the vision routes.
    if (assignedRole !== 'lead_capture' && org.seat_limit != null) {
      const { count, error: countError } = await req.userClient
        .from('users')
        .select('id', { count: 'exact', head: true })
        .neq('role', 'lead_capture');

      if (countError) throw countError;

      if (count >= org.seat_limit) {
        return res.status(403).json({
          error: `You've reached your plan's seat limit (${org.seat_limit} seats used). Contact support or upgrade your plan to add more team members.`,
        });
      }
    }

    // role-based routing: admin/staff/viewer land on the admin console's
    // set-password page; lead_capture lands on the PWA's, since that's
    // the only surface that role ever touches.
    const redirectTo = assignedRole === 'lead_capture'
      ? 'https://app.expopilot.app/set-password'
      : 'https://admin.expopilot.app/set-password';

    // The handle_new_user() trigger reads full_name/organization_id from
    // this metadata to set up the new profile row (status defaults to
    // 'invited' via the column default — see migration). role/org_name
    // are included purely so the "Invite user" email template can
    // reference {{ .Data.role }} / {{ .Data.org_name }} for the
    // role-conditional home-screen-install section.
    const { data: authData, error: authError } = await supabase.auth.admin.inviteUserByEmail(email, {
      data: {
        full_name,
        organization_id: req.user.organization_id,
        role: assignedRole,
        org_name: org.name,
      },
      redirectTo,
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
      .select('id, full_name, email, role, status, created_at')
      .eq('auth_id', authData.user.id)
      .single();

    if (profileError) throw profileError;

    res.status(201).json(profile);
  } catch (err) { next(err); }
});

// POST /api/users/:id/resend-invite — admin: re-send the invite email
// for a user stuck in 'invited' status (expired link, lost the email,
// etc). Blocked once a user is 'active', so this can't be repurposed as
// a password-reset trigger for someone who's already signed in before.
router.post('/:id/resend-invite', requireRole('admin'), async (req, res, next) => {
  try {
    const { data: targetUser, error: targetError } = await req.userClient
      .from('users')
      .select('id, email, full_name, role, status, organization_id')
      .eq('id', req.params.id)
      .maybeSingle();

    if (targetError) throw targetError;
    if (!targetUser) return res.status(404).json({ error: 'User not found' });
    if (targetUser.organization_id !== req.user.organization_id) {
      return res.status(403).json({ error: 'That user is not in your organization' });
    }
    if (targetUser.status === 'active') {
      return res.status(400).json({
        error: 'This user has already completed setup. If they need help signing in, use a password reset instead.',
      });
    }

    const { data: org, error: orgError } = await req.userClient
      .from('organizations')
      .select('name')
      .eq('id', req.user.organization_id)
      .single();

    if (orgError) throw orgError;

    const redirectTo = targetUser.role === 'lead_capture'
      ? 'https://app.expopilot.app/set-password'
      : 'https://admin.expopilot.app/set-password';

    const { error: authError } = await supabase.auth.admin.inviteUserByEmail(targetUser.email, {
      data: {
        full_name: targetUser.full_name,
        organization_id: targetUser.organization_id,
        role: targetUser.role,
        org_name: org.name,
      },
      redirectTo,
    });

    if (authError) throw authError;

    res.json({ message: 'Invite re-sent' });
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

// GET /api/users/assign/mine?conference_id=xxx — self-scoped travel/
// lodging lookup for the PWA's read-only Travel screen. Unlike the
// GET embedded in /api/conferences/:id (admin-facing, returns every
// staff member's assignment for that conference), this always forces
// user_id = req.user.id with no admin override — it's the caller's own
// trips by design, same idea as GET /api/shifts with no user_id passed.
router.get('/assign/mine', async (req, res, next) => {
  try {
    let query = req.userClient
      .from('staff_assignments')
      .select('*, conferences(name, venue, city, state, start_date, end_date)')
      .eq('user_id', req.user.id)
      .order('start_date', { ascending: true, foreignTable: 'conferences' });

    if (req.query.conference_id) query = query.eq('conference_id', req.query.conference_id);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

module.exports = router;
