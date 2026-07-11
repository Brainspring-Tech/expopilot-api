-- Org-issued API keys for third-party integrations. Each key is backed by
-- a "shadow" row in public.users (see shadow_user_id) with a real
-- auth.users identity behind it — requests authenticated by an API key
-- mint a short-lived JWT for that shadow user and flow through the exact
-- same req.userClient + RLS path every normal request already uses,
-- rather than introducing a second, hand-rolled authorization path (this
-- schema has a history of bugs from manual org-scoping in application
-- code — see the leads/assets/users route comments — so reusing the
-- already-hardened RLS path here is deliberate, not incidental).
--
-- permission ('read' | 'read_write') is enforced by the API layer (GET
-- only vs all methods), not by RLS — RLS only ever needs to know the
-- shadow user's own organization_id/role, same as any other user.
--
-- Only the hash of the raw key is ever stored; the raw value is shown to
-- the admin exactly once, at creation time.

create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  description text,
  permission text not null check (permission in ('read', 'read_write')),
  key_hash text not null unique,
  key_prefix text not null,
  enabled boolean not null default true,
  shadow_user_id uuid not null references public.users(id) on delete cascade,
  created_by uuid not null references public.users(id),
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists api_keys_organization_id_idx on public.api_keys(organization_id);
create index if not exists api_keys_key_hash_idx on public.api_keys(key_hash);

alter table public.api_keys enable row level security;

-- Only org admins can see or manage their own org's keys. Matches the
-- "organization_id = (select ... from users where auth_id = auth.uid())"
-- idiom used everywhere else in this schema (see the feedback/
-- conference_messages migrations).
create policy "api_keys: admin manage own org"
  on public.api_keys for all
  to authenticated
  using (
    organization_id = (select organization_id from public.users where auth_id = auth.uid())
    and exists (select 1 from public.users where auth_id = auth.uid() and role = 'admin')
  )
  with check (
    organization_id = (select organization_id from public.users where auth_id = auth.uid())
    and exists (select 1 from public.users where auth_id = auth.uid() and role = 'admin')
  );
