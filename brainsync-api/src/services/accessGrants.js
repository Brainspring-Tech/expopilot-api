// Lazily required (not `const supabase = require('./supabase')` at the
// top) so importing this module doesn't eagerly construct a real Supabase
// client — that constructor throws if SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
// aren't set, which they never are under `node --test` (tests always pass
// their own fake client and should never touch this).
function defaultClient() {
  return require('./supabase');
}

const MIN_MONTHS = 1;
const MAX_MONTHS = 60; // 5 years — generous ceiling, just guards against a fat-fingered entry

// Pure — no I/O — so the access rule itself can be unit tested without a
// real database. `grants` is every grant row for one org (active, expired,
// and revoked); this decides whether ANY of them currently confers access.
//
// Precedence: a real Stripe subscription always wins. A manual grant is
// only consulted when Stripe doesn't already say active — a plain boolean
// OR, so an org with both a live subscription and a leftover grant never
// double-grants anything or conflicts; the grant just becomes redundant.
function computeHasActiveAccess(org, grants, now = new Date()) {
  if (org?.plan_status === 'active') return true;
  return findActiveGrant(grants, now) !== null;
}

// Same "currently active" definition, but returns the grant itself (the
// one expiring furthest in the future, if more than one somehow overlaps)
// rather than a boolean — used to surface reason/expires_at to the UI.
function findActiveGrant(grants, now = new Date()) {
  const active = (grants || []).filter((g) =>
    !g.revoked_at &&
    new Date(g.starts_at) <= now &&
    new Date(g.expires_at) > now
  );
  if (active.length === 0) return null;
  return active.reduce((latest, g) =>
    new Date(g.expires_at) > new Date(latest.expires_at) ? g : latest
  );
}

// Validates the inputs for creating a new grant. Returns an array of
// human-readable error strings — empty means valid. Kept separate from
// the route handler so it's unit-testable without an Express request.
function validateGrantInput({ months, reason }) {
  const errors = [];

  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    errors.push('reason is required');
  }

  const m = Number(months);
  if (!Number.isInteger(m) || m < MIN_MONTHS || m > MAX_MONTHS) {
    errors.push(`months must be a whole number between ${MIN_MONTHS} and ${MAX_MONTHS}`);
  }

  return errors;
}

async function getGrantsForOrg(organizationId, client = defaultClient()) {
  const { data, error } = await client
    .from('manual_access_grants')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

async function getActiveGrantForOrg(organizationId, client = defaultClient(), now = new Date()) {
  const grants = await getGrantsForOrg(organizationId, client);
  return findActiveGrant(grants, now);
}

async function hasActiveAccess(org, client = defaultClient(), now = new Date()) {
  const grants = await getGrantsForOrg(org.id, client);
  return computeHasActiveAccess(org, grants, now);
}

async function logPlatformAction(
  { actorUserId, action, targetOrganizationId, metadata = {} },
  client = defaultClient()
) {
  const { error } = await client.from('platform_audit_log').insert({
    actor_user_id: actorUserId,
    action,
    target_organization_id: targetOrganizationId,
    metadata,
  });
  if (error) console.error('[platform_audit_log] failed to record action:', action, error.message);
}

module.exports = {
  MIN_MONTHS,
  MAX_MONTHS,
  computeHasActiveAccess,
  findActiveGrant,
  validateGrantInput,
  getGrantsForOrg,
  getActiveGrantForOrg,
  hasActiveAccess,
  logPlatformAction,
};
