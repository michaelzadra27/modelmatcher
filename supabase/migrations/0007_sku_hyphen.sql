-- ModelMaster · 0007: TN-223BK and TN223BK are one cartridge.
-- BLI writes Brother parts with a hyphen after the series prefix (TN-223BK, DR-223CL, BU-, WT-, LC-),
-- toner sheets don't, so the same cartridge was stored twice and listed twice on a model (47 pairs
-- on 17 Brother models). mm_sku() now drops that hyphen, then duplicates are merged exactly as in
-- 0006: a toner-sheet link (has a source) wins over a BLI link, so the sheet's price is kept.
-- MUST match skuKey() in src/lib/sku.ts — check with `npm run check:sku`. Safe to re-run.

begin;

-- One spelling per part number (Canon's regional AA suffix; the series-prefix hyphen).
create or replace function mm_part(p text) returns text
language sql immutable as $$
  select regexp_replace(regexp_replace(p, '^(\d{4}[A-Z]\d{3})AA$', '\1'), '^(TN|DR|LC|BU|WT)-(\d)', '\1\2')
$$;

create or replace function mm_sku(raw text) returns text
language plpgsql immutable as $$
declare
  txt     text := btrim(coalesce(raw, ''), E' \t\r\n');
  up      text := upper(txt);
  outside text;
  inside  text[];
  tok     text;
  ins     text[] := '{}';
  outt    text[] := '{}';
  outp    text[] := '{}';
  pos     int;
  in_part text;
  colors  text[] := array['BLACK','CYAN','MAGENTA','YELLOW','C','M','Y','K','BK','CMY','CMYK','COLOR','COLOUR'];
begin
  if up = '' then return txt; end if;
  if length(up) >= 6 and up ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$' and up ~ '\d' then
    return mm_part(up);
  end if;
  if up ~ '\?|CONFIRM|NOT IDENTIFIED|CANNOT BE IDENTIFIED|PRICED BY|\$' then return txt; end if;
  if up ~ '\y(COLORS|COLOURS|SET|SERIES|PACKS?|INKS)\y' then return txt; end if;

  select coalesce(array_agg(m[1]), '{}') into inside from regexp_matches(up, '\(([^()]*)\)', 'g') m;
  outside := regexp_replace(regexp_replace(up, '\([^()]*\)', ' ', 'g'), '[()]', ' ', 'g');
  if position('/' in outside) > 0 then return txt; end if;

  -- Part number inside brackets (only if exactly one, and no bundle slash inside).
  foreach tok in array inside loop
    ins := ins || array(select t from regexp_split_to_table(tok, '[\s,;]+') t where t <> '' and length(t) >= 6 and t ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$' and t ~ '\d');
  end loop;
  if array_length(ins, 1) = 1 and not exists (select 1 from unnest(inside) s where position('/' in s) > 0) then
    in_part := mm_part(ins[1]);
  end if;

  outt := array(select t from regexp_split_to_table(outside, '[\s,;]+') t where t <> '');
  outp := array(select t from unnest(outt) t where length(t) >= 6 and t ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$' and t ~ '\d');
  if coalesce(array_length(outp, 1), 0) > 1 then return txt; end if;
  if array_length(outp, 1) = 1 then
    pos := array_position(outt, outp[1]);
    -- A colour after the code ("GPR-58 C") means it's a series name, not a part number.
    if exists (select 1 from unnest(outt[pos + 1:]) t where t = any(colors)) then return coalesce(in_part, txt); end if;
    return mm_part(outp[1]);
  end if;
  return coalesce(in_part, txt);
end
$$;

-- ── Merge supplies that now share a part number (same steps as 0006) ──

create temp table sku_map on commit drop as
  select s.id, s.sku, mm_sku(s.sku) as nsku from supplies s;

-- One survivor per part number: the row already using the bare part number, else the one with a cost, else oldest.
create temp table sku_keep on commit drop as
  select distinct on (m.nsku) m.nsku, m.id as keep_id
  from sku_map m join supplies s on s.id = m.id
  order by m.nsku, (s.sku = m.nsku) desc, (s.cost is not null) desc, s.created_at, s.id;

create temp table sku_lose on commit drop as
  select m.id as lose_id, k.keep_id
  from sku_map m join sku_keep k on k.nsku = m.nsku
  where m.id <> k.keep_id;

update supplies s set description = coalesce(s.description, s.sku)
from sku_keep k where k.keep_id = s.id and s.sku <> k.nsku;

update supplies s set
  description = coalesce(s.description, o.description),
  supply_type = coalesce(s.supply_type, o.supply_type),
  color       = case when s.color is null or s.color = 'unknown' then coalesce(o.color, s.color) else s.color end,
  yield_pages = coalesce(s.yield_pages, o.yield_pages),
  cost        = coalesce(s.cost, o.cost),
  part_number = coalesce(s.part_number, o.part_number),
  coverage    = coalesce(s.coverage, o.coverage)
from (
  select l.keep_id,
         (array_agg(coalesce(x.description, x.sku)))[1]                                            as description,
         (array_agg(x.supply_type) filter (where x.supply_type is not null))[1]                    as supply_type,
         (array_agg(x.color) filter (where x.color is not null and x.color <> 'unknown'))[1]       as color,
         (array_agg(x.yield_pages) filter (where x.yield_pages is not null))[1]                    as yield_pages,
         (array_agg(x.cost) filter (where x.cost is not null))[1]                                  as cost,
         (array_agg(x.part_number) filter (where x.part_number is not null))[1]                    as part_number,
         (array_agg(x.coverage) filter (where x.coverage is not null))[1]                          as coverage
  from sku_lose l join supplies x on x.id = l.lose_id
  group by l.keep_id
) o
where s.id = o.keep_id;

-- Move model links onto the survivor. If a model already has it, a toner-sheet link (has a source)
-- wins over a BLI link (no source); missing cost/yield are filled from the other.
insert into model_supplies (model_id, supply_id, source_id, cost, yield_pages)
select distinct on (ms.model_id, l.keep_id) ms.model_id, l.keep_id, ms.source_id, ms.cost, ms.yield_pages
from model_supplies ms join sku_lose l on l.lose_id = ms.supply_id
order by ms.model_id, l.keep_id, (ms.source_id is not null) desc, (ms.cost is not null) desc
on conflict (model_id, supply_id) do update set
  source_id   = case when model_supplies.source_id is null and excluded.source_id is not null then excluded.source_id else model_supplies.source_id end,
  cost        = case when model_supplies.source_id is null and excluded.source_id is not null then coalesce(excluded.cost, model_supplies.cost) else coalesce(model_supplies.cost, excluded.cost) end,
  yield_pages = case when model_supplies.source_id is null and excluded.source_id is not null then coalesce(excluded.yield_pages, model_supplies.yield_pages) else coalesce(model_supplies.yield_pages, excluded.yield_pages) end;

delete from model_supplies where supply_id in (select lose_id from sku_lose);
delete from supplies where id in (select lose_id from sku_lose);

-- Survivors take the bare part number as their SKU.
update supplies s set sku = k.nsku, part_number = coalesce(s.part_number, k.nsku)
from sku_keep k where k.keep_id = s.id and s.sku <> k.nsku;

grant execute on function mm_sku(text), mm_part(text) to anon, authenticated;

commit;

-- Check: supplies should equal distinct_parts, and no part should still be spelled with the hyphen.
select count(*) as supplies, count(distinct mm_sku(sku)) as distinct_parts,
       count(*) filter (where sku ~ '^(TN|DR|LC|BU|WT)-\d') as hyphenated_left,
       (select count(*) from model_supplies) as model_links
from supplies;
