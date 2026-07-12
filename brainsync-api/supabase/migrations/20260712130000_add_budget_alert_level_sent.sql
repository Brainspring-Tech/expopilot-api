-- Tracks the highest budget-threshold percentage already alerted on for
-- a conference (0, 80, or 100). Without this, the daily budget-threshold
-- check in jobs/dailyReminders.js would re-notify admins every single
-- day a conference's spend stays above a crossed threshold, instead of
-- once when it's first crossed.

alter table public.conferences
  add column if not exists budget_alert_level_sent integer not null default 0;
