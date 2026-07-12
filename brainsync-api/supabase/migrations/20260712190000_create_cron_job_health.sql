-- Tracks each cron job's last run — previously invisible entirely (the
-- daily reminders, weekly digest, HubSpot sync, and CRM sync jobs all
-- only ever logged to Render's console). One row per job, upserted on
-- every run, so this always reflects current health, not a growing
-- history log (platform_audit_log already covers audit-trail needs).

create table if not exists public.cron_job_health (
  job_name text primary key,
  last_run_at timestamptz,
  last_run_status text, -- 'success' | 'error', reflects the MOST RECENT run only
  last_success_at timestamptz, -- most recent successful run, even if currently erroring — shows how long it's been broken
  last_error_message text, -- cleared on success; only meaningful when last_run_status = 'error'
  last_run_summary jsonb,
  updated_at timestamptz not null default now()
);

alter table public.cron_job_health enable row level security;
-- No policies added — this is only ever read/written via the service-role
-- client (the cron jobs themselves, and the platform-operator route),
-- same pattern already used for manual_access_grants/platform_audit_log.
