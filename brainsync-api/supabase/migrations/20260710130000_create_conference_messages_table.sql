-- Conference chat (PWA) — real-time messaging between logged-in users at
-- the same conference, scoped to their own org. Mirrors the org-scoping
-- convention from the feedback migration (organization_id column, RLS
-- subquery against public.users keyed by auth_id = auth.uid()), since that
-- is the only precedent in this schema.
--
-- Unlike feedback, a message also carries conference_id, so the insert
-- policy additionally checks that the target conference actually belongs
-- to the caller's own org — otherwise a caller could stamp their own
-- organization_id but attach messages to a conference_id from another org.
--
-- Append-only for v1: no update/delete policies, so there's no message
-- editing or deletion yet.

create table if not exists public.conference_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conference_id uuid not null references public.conferences(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index if not exists conference_messages_conference_id_idx
  on public.conference_messages(conference_id, created_at);

create index if not exists conference_messages_organization_id_idx
  on public.conference_messages(organization_id);

alter table public.conference_messages enable row level security;

-- Required for the PWA's Supabase Realtime subscription to receive
-- postgres_changes events on this table.
alter publication supabase_realtime add table public.conference_messages;

-- Read: any org member can read messages for a conference in their own org.
create policy "conference_messages: org member read"
  on public.conference_messages for select
  to authenticated
  using (
    organization_id = (select organization_id from public.users where auth_id = auth.uid())
  );

-- Insert: org member posting as themselves, into a conference that's
-- actually theirs (not just an organization_id match).
create policy "conference_messages: org member insert own"
  on public.conference_messages for insert
  to authenticated
  with check (
    organization_id = (select organization_id from public.users where auth_id = auth.uid())
    and user_id = (select id from public.users where auth_id = auth.uid())
    and exists (
      select 1 from public.conferences c
      where c.id = conference_id and c.organization_id = organization_id
    )
  );
