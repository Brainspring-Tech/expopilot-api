-- Adds the six new daily-reminder notification keys (task_due_reminder,
-- shift_reminder, shipping_deadline_reminder, budget_threshold_alert,
-- post_conference_wrapup, inactivity_nudge) introduced alongside
-- src/jobs/dailyReminders.js.
--
-- Same reasoning as the two prior notification_prefs migrations: a
-- jsonb column DEFAULT only applies at INSERT time, so without this,
-- every existing user's stored prefs simply lack these keys and
-- notifyIfEnabled() treats a missing key as disabled — the feature
-- would ship functionally off for the whole existing user base.

update public.users
set notification_prefs = notification_prefs || '{
  "task_due_reminder": true,
  "shift_reminder": true,
  "shipping_deadline_reminder": true,
  "budget_threshold_alert": true,
  "post_conference_wrapup": true,
  "inactivity_nudge": true
}'::jsonb
where notification_prefs is not null;

alter table public.users
  alter column notification_prefs set default '{
    "conference_assignment": true,
    "task_assignment": true,
    "discussion_comment": true,
    "shift_calendar_invite": true,
    "weekly_admin_digest": true,
    "weekly_personal_summary": true,
    "task_due_reminder": true,
    "shift_reminder": true,
    "shipping_deadline_reminder": true,
    "budget_threshold_alert": true,
    "post_conference_wrapup": true,
    "inactivity_nudge": true
  }'::jsonb;
