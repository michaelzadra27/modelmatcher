-- Structured toner support. Run after 0001_init.sql.
--
-- Supplies already hold sku / color / yield_pages / supply_type; add per-toner cost so a
-- toner's price lives on the toner itself (one TN420 is $48.79 for every model that uses it),
-- and let model_supplies carry the source-stated yield in case it varies by sheet.

alter table supplies add column if not exists cost numeric(10, 2);
alter table model_supplies add column if not exists cost numeric(10, 2);
alter table model_supplies add column if not exists yield_pages integer;

-- What other apps query: a device's MM- key → each toner with colour, cost and yield.
create or replace view model_toners as
select m.canonical_key,
       m.id as model_id,
       s.supply_type as type,
       s.color,
       s.sku,
       coalesce(ms.cost, s.cost) as cost,
       coalesce(ms.yield_pages, s.yield_pages) as yield_pages,
       src.name as source
from model_supplies ms
join models m on m.id = ms.model_id
join supplies s on s.id = ms.supply_id
left join sources src on src.id = ms.source_id;

-- Resolve a messy device name straight to its toners in one call (name in → toners out).
create or replace function toners_for_name(p_name text)
returns setof model_toners
language sql stable as $$
  select t.* from model_toners t
  join model_aliases a on a.model_id = t.model_id
  where a.status = 'linked'
    and a.alias_normalized = upper(regexp_replace(p_name, '[^A-Za-z0-9]', '', 'g'))
$$;
