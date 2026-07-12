-- Basic organization profile fields (address, phone) for the new
-- Settings > Organization tab — organizations previously only had a
-- name, no way to record contact/mailing info.

alter table public.organizations
  add column if not exists phone text,
  add column if not exists address_line1 text,
  add column if not exists city text,
  add column if not exists state text,
  add column if not exists postal_code text;
