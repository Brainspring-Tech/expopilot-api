-- The `feedback.area` CHECK constraint was originally scoped to the PWA's
-- small page set (leads/conferences/prep/dashboard/other). Now that the
-- admin console also has a feedback widget, its much larger surface area
-- needs its own values so submissions actually get tagged usefully
-- instead of piling up under "other". Postgres's default name for an
-- inline CHECK on this column is `feedback_area_check` (table_column_check);
-- `if exists`/recreate makes this safe to re-run.
alter table public.feedback drop constraint if exists feedback_area_check;
alter table public.feedback add constraint feedback_area_check
  check (area in (
    'leads', 'conferences', 'prep', 'dashboard', 'other',      -- PWA
    'assets', 'tasks', 'expenses', 'roi', 'users', 'settings', -- admin console
    'prospects', 'platform'
  ));
