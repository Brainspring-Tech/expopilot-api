-- Lets an org configure which calendar month its fiscal year begins
-- (1 = January ... 12 = December). Defaults to 1 so every existing org
-- keeps today's Jan-Dec behavior for the Dashboard budget trend chart
-- (src/routes/conferences.js's budget-summary endpoint) until an admin
-- explicitly sets something else via PATCH /api/organizations/me.

alter table public.organizations
  add column if not exists fiscal_year_start_month integer not null default 1
  check (fiscal_year_start_month between 1 and 12);
