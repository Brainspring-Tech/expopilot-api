const express  = require('express');
const crypto   = require('crypto');
const router   = express.Router();
const { requireAuth, requireRole, blockApiKey } = require('../middleware/auth');
const { generateApiKey } = require('../services/apiKeys');
// Service-role client — needed for the auth-admin calls (createUser/
// deleteUser have no RLS-equivalent), same as users.js's invite/delete
// routes. req.userClient still does all the actual api_keys table reads
// and writes below; this is only for the auth.users side of a key.
const supabase = require('../services/supabase');

router.use(requireAuth);
// An API key must never be usable to mint or manage other API keys —
// that's the one hard boundary on top of "read_write = admin-equivalent
// access", since it's the one path that could otherwise let a leaked key
// silently issue itself a replacement or broaden its own permissions.
router.use(blockApiKey);
router.use(requireRole('admin'));

// GET /api/api-keys — never returns key_hash; the raw key itself is only
// ever shown once, in the POST response below.
router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await req.userClient
      .from('api_keys')
      .select('id, name, description, permission, enabled, key_prefix, last_used_at, created_at')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/api-keys — creates a "shadow" auth identity for this key to
// authenticate as (see the api_keys migration for why), then the key
// itself. The raw key is returned exactly once here and never stored —
// only its hash is kept, in the insert below.
router.post('/', async (req, res, next) => {
  try {
    const { name, description, permission } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (!['read', 'read_write'].includes(permission)) {
      return res.status(400).json({ error: "permission must be 'read' or 'read_write'" });
    }

    const shadowEmail = `apikey-${crypto.randomUUID()}@keys.expopilot.internal`;
    const shadowPassword = crypto.randomBytes(24).toString('base64url');

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: shadowEmail,
      password: shadowPassword,
      email_confirm: true,
      user_metadata: {
        full_name: `API Key: ${name.trim()}`,
        organization_id: req.user.organization_id,
        role: 'admin',
      },
    });
    if (authError) throw authError;

    // The handle_new_user() trigger (see users.js's invite route comment)
    // reads user_metadata to set up the profile row, but its defaults
    // (e.g. status) are tuned for real human invites — pin down exactly
    // what this shadow profile needs rather than trusting the trigger's
    // defaults, same defensive pattern POST /api/users already uses
    // right after inviteUserByEmail.
    const { data: shadowProfile, error: profileError } = await supabase
      .from('users')
      .update({ role: 'admin', organization_id: req.user.organization_id, status: 'active' })
      .eq('auth_id', authData.user.id)
      .select('id')
      .single();
    if (profileError) throw profileError;

    const { raw, hash, prefix } = generateApiKey();

    const { data: apiKey, error: insertError } = await req.userClient
      .from('api_keys')
      .insert({
        organization_id: req.user.organization_id,
        name: name.trim(),
        description: description || null,
        permission,
        key_hash: hash,
        key_prefix: prefix,
        shadow_user_id: shadowProfile.id,
        created_by: req.user.id,
      })
      .select('id, name, description, permission, enabled, key_prefix, last_used_at, created_at')
      .single();

    if (insertError) {
      // Roll back the shadow identity we just created — best-effort,
      // don't let a cleanup failure mask the original insert error.
      await supabase.auth.admin.deleteUser(authData.user.id).catch(() => {});
      throw insertError;
    }

    res.status(201).json({ ...apiKey, key: raw });
  } catch (err) { next(err); }
});

// PATCH /api/api-keys/:id — name/description/enabled/permission only;
// the key material itself (hash, shadow identity) is immutable — issue a
// new key instead of trying to "rotate" one in place.
router.patch('/:id', async (req, res, next) => {
  try {
    const allowed = ['name', 'description', 'enabled', 'permission'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );
    if (updates.permission && !['read', 'read_write'].includes(updates.permission)) {
      return res.status(400).json({ error: "permission must be 'read' or 'read_write'" });
    }

    const { data, error } = await req.userClient
      .from('api_keys')
      .update(updates)
      .eq('id', req.params.id)
      .select('id, name, description, permission, enabled, key_prefix, last_used_at, created_at')
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'API key not found' });
    res.json(data);
  } catch (err) { next(err); }
});

// DELETE /api/api-keys/:id — revokes the key and removes its shadow
// identity. Switched to req.userClient for the lookup/delete so this can
// only ever target a key in the caller's own org (RLS), same reasoning
// as DELETE /api/users/:id.
router.delete('/:id', async (req, res, next) => {
  try {
    const { data: keyRow, error: lookupError } = await req.userClient
      .from('api_keys')
      .select('id, shadow_user_id, users!api_keys_shadow_user_id_fkey(auth_id)')
      .eq('id', req.params.id)
      .maybeSingle();

    if (lookupError) throw lookupError;
    if (!keyRow) return res.status(404).json({ error: 'API key not found' });

    const { error: deleteError } = await req.userClient.from('api_keys').delete().eq('id', req.params.id);
    if (deleteError) throw deleteError;

    // Best-effort, same pattern as DELETE /api/users/:id — the api_keys
    // row is already gone (which is what actually stops the key working
    // going forward, since auth lookups join through it), so a cleanup
    // failure here just leaves an orphaned shadow identity, not a
    // security hole.
    if (keyRow.users?.auth_id) {
      const { error: authDeleteError } = await supabase.auth.admin.deleteUser(keyRow.users.auth_id);
      if (authDeleteError) {
        console.warn(`[api-keys] auth.admin.deleteUser failed for ${keyRow.users.auth_id}:`, authDeleteError.message);
      }
    }

    res.status(204).send();
  } catch (err) { next(err); }
});

module.exports = router;
