-- Free-text identifier field for companies that tag physical assets with
-- their own alphanumeric codes (e.g. asset-tracking labels). Added to
-- both the reusable catalog template and the per-conference asset
-- instance, since a specific physical unit's code is independent of
-- (and not inherited from) its catalog template — same relationship
-- quantity/ship dates already have to the catalog item.

alter table public.asset_catalog
  add column if not exists asset_code text;

alter table public.booth_assets
  add column if not exists asset_code text;
