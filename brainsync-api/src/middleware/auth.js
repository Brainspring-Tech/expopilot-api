const { createClient } = require('@supabase/supabase-js');
const { hashApiKey, looksLikeApiKey, mintShadowUserToken } = require('../services/apiKeys');

// Per-request client that respects the caller's JWT (for RLS)
function getUserClient(token) {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    }
  );
}

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' });
  }

  const token = authHeader.split(' ')[1];

  if (looksLikeApiKey(token)) {
    return authenticateApiKey(token, req, res, next);
  }

  // Verify the JWT with Supabase
  const verifier = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const { data: { user }, error } = await verifier.auth.getUser(token);
  if (error || !user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Pull role, organization, platform_operator flag, and profile fields
  // (job_title/phone/avatar_url) from public.users. is_platform_operator
  // gates access to cross-org platform visibility routes (see
  // requirePlatformOperator below) — it's separate from role because
  // it's not org-scoped like admin/staff/lead_capture are.
  const { data: profile } = await verifier
    .from('users')
    .select('id, full_name, email, role, organization_id, is_platform_operator, job_title, phone, avatar_url, notification_prefs')
    .eq('auth_id', user.id)
    .single();

  req.user      = profile || { auth_id: user.id, email: user.email, role: 'staff', is_platform_operator: false };
  req.token     = token;
  req.userClient = getUserClient(token);  // RLS-scoped client for reads AND writes
  next();
}

// API-key auth resolves to a "shadow" user (see the api_keys migration)
// and mints that shadow user a short-lived real session token, so the
// rest of the request flows through the exact same req.userClient + RLS
// path as a normal logged-in user — no second, hand-rolled authorization
// path. `permission: 'read'` additionally hard-blocks any non-GET method
// here, before the request ever reaches a route handler.
async function authenticateApiKey(rawKey, req, res, next) {
  const verifier = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const { data: apiKey, error } = await verifier
    .from('api_keys')
    .select('id, permission, enabled, users!api_keys_shadow_user_id_fkey(id, auth_id, full_name, email, role, organization_id, is_platform_operator, job_title, phone, avatar_url, notification_prefs)')
    .eq('key_hash', hashApiKey(rawKey))
    .maybeSingle();

  if (error || !apiKey || !apiKey.enabled || !apiKey.users) {
    return res.status(401).json({ error: 'Invalid or disabled API key' });
  }

  if (apiKey.permission === 'read' && req.method !== 'GET') {
    return res.status(403).json({ error: 'This API key is read-only' });
  }

  const shadowToken = mintShadowUserToken(apiKey.users.auth_id);

  req.user        = apiKey.users;
  req.token       = shadowToken;
  req.userClient  = getUserClient(shadowToken);
  req.authMethod  = 'api_key';

  // Fire-and-forget — don't hold up the request on this.
  verifier.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', apiKey.id)
    .then(() => {}, () => {});

  next();
}

// Blocks API-key-authenticated requests from user/org/key-management
// routes — an API key gets full read/write access to business data
// (leads, conferences, assets, etc), same as an admin, but can't use
// that access to manage other users, billing, or other API keys. Mount
// this ahead of those routers, after requireAuth.
function blockApiKey(req, res, next) {
  if (req.authMethod === 'api_key') {
    return res.status(403).json({ error: 'Not available to API keys' });
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Gates routes that intentionally see across ALL organizations — e.g. the
// platform-operator overview screen. This is a hard, narrow allowlist
// check (not a role), since being an org's "admin" should never imply
// visibility into other orgs' data. Routes behind this middleware should
// use the service-role Supabase client, not req.userClient, since RLS
// would otherwise correctly block cross-org reads anyway.
function requirePlatformOperator(req, res, next) {
  if (!req.user?.is_platform_operator) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  next();
}

module.exports = { requireAuth, requireRole, requirePlatformOperator, blockApiKey };
