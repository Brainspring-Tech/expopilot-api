const { createClient } = require('@supabase/supabase-js');

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

  // Pull role, organization, AND platform_operator flag from public.users.
  // is_platform_operator gates access to cross-org platform visibility
  // routes (see requirePlatformOperator below) — it's separate from role
  // because it's not org-scoped like admin/staff/lead_capture are.
  const { data: profile } = await verifier
    .from('users')
    .select('id, full_name, email, role, organization_id, is_platform_operator')
    .eq('auth_id', user.id)
    .single();

  req.user      = profile || { auth_id: user.id, email: user.email, role: 'staff', is_platform_operator: false };
  req.token     = token;
  req.userClient = getUserClient(token);  // RLS-scoped client for reads AND writes
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

module.exports = { requireAuth, requireRole, requirePlatformOperator };
