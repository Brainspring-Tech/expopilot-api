const express  = require('express');
const router   = express.Router();
const supabase = require('../services/supabase');

// NOTE: deliberately no `router.use(requireAuth)` here — this is the one
// endpoint in the whole API that must be reachable by someone who doesn't
// have an account yet.

const TRIAL_DAYS = 14;

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'org';
}

// Finds a slug that doesn't collide with an existing organization,
// appending a short random suffix if needed.
async function generateUniqueSlug(orgName) {
  const base = slugify(orgName);
  let slug = base;

  for (let attempt = 0; attempt < 6; attempt++) {
    const { data, error } = await supabase
      .from('organizations')
      .select('id')
      .eq('slug', slug)
      .maybeSingle();

    if (error) throw error;
    if (!data) return slug;

    slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;
  }

  throw new Error('Could not generate a unique organization slug');
}

// Best-effort teardown for a signup attempt that failed partway through.
// Never lets a cleanup failure mask the original error.
async function cleanup({ orgId, authUserId }) {
  try {
    if (authUserId) {
      await supabase.auth.admin.deleteUser(authUserId);
    }
  } catch (err) {
    console.error('[signup] cleanup: failed to delete auth user', authUserId, err.message);
  }
  try {
    if (orgId) {
      await supabase.from('organizations').delete().eq('id', orgId);
    }
  } catch (err) {
    console.error('[signup] cleanup: failed to delete organization', orgId, err.message);
  }
}

// POST /api/signup — self-serve: creates a new organization plus its
// first (admin) user in one go. Public — no auth required.
router.post('/', async (req, res, next) => {
  let orgId = null;
  let authUserId = null;

  try {
    const { org_name, admin_full_name, admin_email, admin_password } = req.body;

    if (!org_name || !admin_full_name || !admin_email || !admin_password) {
      return res.status(400).json({
        error: 'org_name, admin_full_name, admin_email, and admin_password are required',
      });
    }
    if (admin_password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const slug = await generateUniqueSlug(org_name);
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // 1. Create the organization first — the new user's metadata needs
    // its id to satisfy the organization_id NOT NULL constraint that
    // handle_new_user() writes into public.users.
    const { data: org, error: orgError } = await supabase
      .from('organizations')
      .insert({ name: org_name, slug, trial_ends_at: trialEndsAt, plan_status: 'trial' })
      .select()
      .single();

    if (orgError) throw orgError;
    orgId = org.id;

    // 2. Create the auth user. Same metadata pattern as the existing
    // admin-invite flow in routes/users.js, so it flows through the
    // same handle_new_user() trigger.
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: admin_email,
      password: admin_password,
      email_confirm: true,
      user_metadata: { full_name: admin_full_name, organization_id: orgId },
    });

    if (authError) {
      await cleanup({ orgId });
      if (authError.message?.includes('already been registered')) {
        return res.status(409).json({ error: 'An account with this email already exists' });
      }
      throw authError;
    }
    authUserId = authData.user.id;

    // 3. Promote to admin — new profile rows default to the table's
    // normal default role (staff).
    const { error: roleError } = await supabase
      .from('users')
      .update({ role: 'admin' })
      .eq('auth_id', authUserId);

    if (roleError) throw roleError;

    // 4. Verify the profile row actually exists. handle_new_user() catches
    // its own errors and just logs a warning rather than failing the auth
    // user creation — so without this check, a trigger failure would look
    // like a successful signup with no way to ever log in.
    const { data: profile, error: profileError } = await supabase
      .from('users')
      .select('id, full_name, email, role, organization_id')
      .eq('auth_id', authUserId)
      .maybeSingle();

    if (profileError) throw profileError;
    if (!profile) {
      throw new Error('Account setup did not complete — please try again');
    }

    res.status(201).json({
      organization: { id: org.id, name: org.name, slug: org.slug, trial_ends_at: org.trial_ends_at },
      user: profile,
    });
  } catch (err) {
    await cleanup({ orgId, authUserId });
    next(err);
  }
});

module.exports = router;
