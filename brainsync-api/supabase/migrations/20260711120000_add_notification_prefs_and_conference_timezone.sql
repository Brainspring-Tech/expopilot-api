-- Adds the storage needed for per-user email/calendar notification
-- toggles and per-conference timezone (needed to convert shift
-- date/time-of-day into a correct UTC calendar invite).
--
-- notification_prefs defaults every existing user to all-on, so nobody
-- silently goes dark on assignment/task/discussion/shift emails the
-- moment this migration runs — they have to explicitly opt out.
--
-- timezone defaults to America/Chicago (org HQ) for existing rows and
-- any new conference that doesn't set one explicitly.

alter table public.users
  add column if not exists notification_prefs jsonb not null default '{
    "conference_assignment": true,
    "task_assignment": true,
    "discussion_comment": true,
    "shift_calendar_invite": true
  }'::jsonb;

alter table public.conferences
  add column if not exists timezone text not null default 'America/Chicago';
