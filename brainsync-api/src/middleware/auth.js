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

  // Pull role AND organization from public.users — organization_id is
  // required everywhere now that the app is multi-tenant, so it needs
  // to be on req.user alongside role.
  const { data: profile } = await verifier
    .from('users')
    .select('id, full_name, email, role, organization_id')
    .eq('auth_id', user.id)
    .single();

  req.user      = profile || { auth_id: user.id, email: user.email, role: 'staff' };
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

module.exports = { requireAuth, requireRole };
