-- Tracks failed Stripe payments per org — previously invisible entirely
-- (no invoice.payment_failed webhook handler existed at all; an org's
-- card could fail silently for a full dunning cycle before plan_status
-- ever flipped to past_due). payment_failure_count resets to 0 on the
-- next invoice.payment_succeeded, so it only ever reflects the CURRENT
-- unresolved streak, not lifetime failures.

alter table public.organizations
  add column if not exists last_payment_failed_at timestamptz,
  add column if not exists payment_failure_count integer not null default 0;
