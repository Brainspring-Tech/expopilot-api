-- Adds the two new weekly-rollup notification keys (weekly_admin_digest,
-- weekly_personal_summary) introduced alongside src/jobs/weeklyDigest.js.
--
-- A jsonb column DEFAULT only applies at INSERT time — adding these keys
-- to NOTIFICATION_PREF_KEYS in code does nothing for rows that already
-- exist, since their stored jsonb blob simply doesn't have the new keys
-- and notifyIfEnabled() treats a missing key as falsy (disabled). Same
-- reasoning as the original notification_prefs migration: default
-- everyone to on, or the feature ships functionally off for the entire
-- existing user base until each person happens to visit their profile
-- and flip something.

update public.users
set notification_prefs = notification_prefs || '{
  "weekly_admin_digest": true,
  "weekly_personal_summary": true
}'::jsonb
where notification_prefs is not null;

alter table public.users
  alter column notification_prefs set default '{
    "conference_assignment": true,
    "task_assignment": true,
    "discussion_comment": true,
    "shift_calendar_invite": true,
    "weekly_admin_digest": true,
    "weekly_personal_summary": true
  }'::jsonb;
