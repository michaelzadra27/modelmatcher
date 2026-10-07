-- Model Master — Supabase schema
--
-- One canonical row per physical model (`models`). Every messy name from every source
-- is an alias that points at it (`model_aliases`). Variants (M428dn / M428fdw), toner and
-- supply SKUs, and price-book entries all hang off the model, so other apps can join on a
-- single stable id instead of matching strings.
--
-- Run in the Supabase SQL editor. A new project is recommended; the only table name shared
-- with the Device Catalog is `manufacturers`.

create extension if not exists pgcrypto;

-- ── Manufacturers ──────────────────────────────────────────────────────────
create table if not exists manufacturers (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,            -- canonical, e.g. "HP"
  aliases    text[] not null default '{}',
  created_at timestamptz not null default now()
);

-- ── Canonical models ───────────────────────────────────────────────────────
create table if not exists models (
  id              uuid primary key default gen_random_uuid(),
  canonical_key   text not null unique,       -- stable human-readable id, e.g. HP-M428
  manufacturer_id uuid references manufacturers(id) on delete set null,
  model           text not null,              -- e.g. M428
  family          text,
  device_type     text,                       -- BW-MFP, CLR-SFP, ...
  ppm             integer,
  color           text,
  paper_size      text,
  toner_family    text,
  notes           text,
  attributes      jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_models_manufacturer on models(manufacturer_id);
create index if not exists idx_models_type on models(device_type);

-- ── Variants (fdw / fdn / dw ...) ──────────────────────────────────────────
create table if not exists model_variants (
  id          uuid primary key default gen_random_uuid(),
  model_id    uuid not null references models(id) on delete cascade,
  variant     text not null,                  -- FDW
  description text,
  attributes  jsonb not null default '{}'::jsonb,
  unique (model_id, variant)
);

-- ── Sources (each uploaded sheet / system) ─────────────────────────────────
create table if not exists sources (
  id               uuid primary key default gen_random_uuid(),
  name             text not null unique,      -- "UDCA Models", "Price Book 2026"
  column_roles     jsonb not null default '{}'::jsonb,  -- {"Toner SKU":"supply", ...}
  last_imported_at timestamptz not null default now()
);

-- ── Aliases: every raw name from every source ──────────────────────────────
create table if not exists model_aliases (
  id               uuid primary key default gen_random_uuid(),
  source_id        uuid not null references sources(id) on delete cascade,
  raw_name         text not null,
  alias_normalized text generated always as (upper(regexp_replace(raw_name, '[^A-Za-z0-9]', '', 'g'))) stored,
  model_id         uuid references models(id) on delete set null,
  variant_id       uuid references model_variants(id) on delete set null,
  status           text not null default 'pending' check (status in ('pending', 'linked', 'ignored')),
  row_count        integer not null default 1,        -- source rows collapsed into this name
  attributes       jsonb not null default '{}'::jsonb, -- the source row's other columns
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (source_id, raw_name)
);
create index if not exists idx_aliases_norm   on model_aliases(alias_normalized);
create index if not exists idx_aliases_model  on model_aliases(model_id);
create index if not exists idx_aliases_status on model_aliases(status);

-- ── Supplies (toner / ink / drums, sellable SKUs) ──────────────────────────
create table if not exists supplies (
  id          uuid primary key default gen_random_uuid(),
  sku         text not null unique,
  description text,
  supply_type text,                           -- toner | ink | drum | maintenance
  color       text,
  yield_pages integer,
  attributes  jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- Many-to-many: a toner fits several models, a model takes several toners.
create table if not exists model_supplies (
  model_id  uuid not null references models(id) on delete cascade,
  supply_id uuid not null references supplies(id) on delete cascade,
  source_id uuid references sources(id) on delete set null,
  primary key (model_id, supply_id)
);
create index if not exists idx_model_supplies_supply on model_supplies(supply_id);

-- ── Price book ─────────────────────────────────────────────────────────────
create table if not exists price_lists (
  id             uuid primary key default gen_random_uuid(),
  source_id      uuid not null references sources(id) on delete cascade,
  name           text not null,
  effective_date date,
  currency       text not null default 'USD',
  created_at     timestamptz not null default now(),
  unique (source_id, name)
);

-- A price attaches to the *alias* (the name as the price book wrote it). The model comes
-- from the alias, so re-linking an alias automatically re-prices the right model.
create table if not exists price_entries (
  id            uuid primary key default gen_random_uuid(),
  price_list_id uuid not null references price_lists(id) on delete cascade,
  alias_id      uuid not null references model_aliases(id) on delete cascade,
  price_type    text not null default 'list',   -- column header: "List", "Dealer", "Cost"
  price         numeric(12, 2),
  attributes    jsonb not null default '{}'::jsonb,
  unique (price_list_id, alias_id, price_type)
);
create index if not exists idx_price_entries_alias on price_entries(alias_id);

-- ── Review log ─────────────────────────────────────────────────────────────
create table if not exists review_log (
  id         bigint generated always as identity primary key,
  source     text,
  raw_name   text,
  decision   text not null,                    -- created | linked | merged | ignored | auto-linked
  model_key  text,
  reviewer   uuid default auth.uid(),
  decided_on text,
  created_at timestamptz not null default now()
);

-- ── updated_at triggers ────────────────────────────────────────────────────
create or replace function set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end $$ language plpgsql;

drop trigger if exists trg_models_updated on models;
create trigger trg_models_updated before update on models
  for each row execute function set_updated_at();
drop trigger if exists trg_aliases_updated on model_aliases;
create trigger trg_aliases_updated before update on model_aliases
  for each row execute function set_updated_at();

-- ── Views other apps can read ──────────────────────────────────────────────
create or replace view model_catalog as
select m.*, mf.name as manufacturer,
       (select count(*) from model_aliases a where a.model_id = m.id and a.status = 'linked') as alias_count,
       (select count(*) from model_variants v where v.model_id = m.id) as variant_count,
       (select count(*) from model_supplies s where s.model_id = m.id) as supply_count
from models m left join manufacturers mf on mf.id = m.manufacturer_id;

create or replace view model_prices as
select m.id as model_id, m.canonical_key, v.variant, pl.name as price_list, pe.price_type, pe.price,
       a.raw_name, s.name as source
from price_entries pe
join price_lists pl on pl.id = pe.price_list_id
join model_aliases a on a.id = pe.alias_id
join sources s on s.id = a.source_id
join models m on m.id = a.model_id
left join model_variants v on v.id = a.variant_id;

-- ── Lookup: raw text → canonical model (the call other apps make) ──────────
create or replace function resolve_model(p_name text)
returns table (model_id uuid, canonical_key text, variant text, matches integer)
language sql stable as $$
  select a.model_id, m.canonical_key, v.variant, count(*)::integer
  from model_aliases a
  join models m on m.id = a.model_id
  left join model_variants v on v.id = a.variant_id
  where a.status = 'linked'
    and a.alias_normalized = upper(regexp_replace(p_name, '[^A-Za-z0-9]', '', 'g'))
  group by a.model_id, m.canonical_key, v.variant
  order by 4 desc
  limit 1
$$;

-- ── Row-level security: signed-in users only ───────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['manufacturers','models','model_variants','sources','model_aliases',
                           'supplies','model_supplies','price_lists','price_entries','review_log']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "authenticated full access" on %I', t);
    execute format('create policy "authenticated full access" on %I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;
