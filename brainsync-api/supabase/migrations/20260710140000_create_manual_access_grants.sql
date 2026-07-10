-- Manual (non-Stripe) access grants for the platform operator to comp an
-- organization — e.g. Expo Pilot beta testers who should get full platform
-- access without ever going through Stripe checkout. Deliberately its own
-- table rather than faking Stripe fields on `organizations`: a grant is
-- never confused with a real subscription, so pilot usage can be reported
-- on separately from paying customers, and so nothing here writes to
-- stripe_customer_id/stripe_subscription_id/plan_status.
--
-- Access-check precedence (see src/services/accessGrants.js): a real
-- Stripe subscription (organizations.plan_status = 'active') always wins;
-- an active, unexpired, unrevoked grant only matters when Stripe doesn't
-- already say active. This is a plain boolean OR, so an org having both
-- never double-grants or conflicts — the grant just becomes redundant
-- once real billing kicks in.
--
-- One row per grant, not per org — an org can have a history of past
-- (expired/revoked) grants; "currently active" is derived at query time
-- from starts_at/expires_at/revoked_at rather than a stored status flag,
-- since nothing else in this codebase uses a cron to flip status columns
-- (vision.js's monthly quota is the closest precedent, and it's lazy too).

create table if not exists public.manual_access_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  granted_by_user_id uuid not null references public.users(id),
  reason text not null,
  starts_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by_user_id uuid references public.users(id),
  created_at timestamptz not null default now(),
  constraint manual_access_grants_expires_after_starts check (expires_at > starts_at),
  constraint manual_access_grants_revoked_by_requires_revoked_at
    check ((revoked_by_user_id is null) = (revoked_at is null))
);

create index if not exists manual_access_grants_organization_id_idx
  on public.manual_access_grants(organization_id);

-- Speeds up the "does this org have a currently-active grant" lookup
-- (the hot path checked on billing/access reads).
create index if not exists manual_access_grants_active_idx
  on public.manual_access_grants(organization_id, expires_at)
  where revoked_at is null;

alter table public.manual_access_grants enable row level security;
-- No policies defined: every read/write to this table goes through the
-- service-role client in src/routes/platform.js (guarded by
-- requirePlatformOperator), same reasoning as the platform overview/limits
-- routes bypassing RLS on `organizations`. RLS is enabled anyway so a
-- future req.userClient (RLS-scoped) query against this table fails
-- closed by default rather than silently leaking cross-org grant data.

-- A simple, generic audit log for platform-operator actions — none
-- existed anywhere in this schema before this feature. Kept intentionally
-- narrow (actor, action, target org, free-form metadata) so it can cover
-- future platform-operator actions too, not just grants.
create table if not exists public.platform_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references public.users(id),
  action text not null,
  target_organization_id uuid references public.organizations(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists platform_audit_log_target_organization_id_idx
  on public.platform_audit_log(target_organization_id);
create index if not exists platform_audit_log_created_at_idx
  on public.platform_audit_log(created_at desc);

alter table public.platform_audit_log enable row level security;
-- No policies: written and read only via the service-role client from
-- platform-operator-gated routes, same as manual_access_grants above.
