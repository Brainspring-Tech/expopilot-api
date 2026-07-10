-- Feedback widget (PWA) — lets any authenticated user submit feedback.
-- Mirrors the org-scoped RLS pattern used throughout this schema (see
-- the users/tasks/staff_assignments policies): insert is open to any
-- org member for their own org, but reading feedback back is
-- admin-only, since `message`/`contact_email` may contain sensitive or
-- identifying content.
--
-- Note on naming, deliberately deviating from the original feature
-- spec to match this schema's existing conventions:
--   - column is `organization_id`, not `org_id` — every other table
--     (users, staff_assignments, staff_shifts, ...) uses this name.
--   - `user_id` references public.users(id), not auth.users(id) —
--     public.users.id is the FK target used everywhere else in this
--     schema (tasks.assigned_to, staff_shifts.user_id, etc.);
--     public.users has its own separate `auth_id` column bridging to
--     auth.users, so referencing auth.users directly here would be
--     inconsistent with the rest of the app and awkward to join.

create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  type text not null check (type in ('bug', 'idea', 'question', 'praise')),
  area text not null check (area in ('leads', 'conferences', 'prep', 'dashboard', 'other')),
  message text,
  rating smallint check (rating between 1 and 5),
  contact_ok boolean not null default false,
  contact_email text,
  page_url text,
  app_version text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists feedback_organization_id_idx on public.feedback(organization_id);
create index if not exists feedback_created_at_idx on public.feedback(created_at desc);

alter table public.feedback enable row level security;

-- Any authenticated org member can submit feedback for their own org.
-- organization_id/user_id are always set server-side from the session
-- (see POST /api/feedback) rather than trusted from client input, so
-- this policy just confirms the row being inserted matches the
-- caller's own org.
create policy "feedback: user insert own org"
  on public.feedback for insert
  to authenticated
  with check (
    organization_id = (select organization_id from public.users where auth_id = auth.uid())
  );

-- Only org admins can read feedback for their own org.
create policy "feedback: admin read own org"
  on public.feedback for select
  to authenticated
  using (
    organization_id = (select organization_id from public.users where auth_id = auth.uid())
    and exists (
      select 1 from public.users
      where auth_id = auth.uid() and role = 'admin'
    )
  );
