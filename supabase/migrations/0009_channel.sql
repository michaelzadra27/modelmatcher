-- ModelMaster · 0009 sales channel: is a model sold through the dealer channel or retail?
-- channel  = channel_override (set per model) if present, else the rule in mm_channel(), else null (unknown).
-- channel_source = 'override' | 'rule' | null, so callers can tell a hand-set answer from a rule's.
-- Rules live in one function: change them with "create or replace function mm_channel" and every model
-- updates at once (nothing stored per model, nothing to Push). Safe to re-run.

begin;

-- Per-model exception. Push never sends this column, so its upsert leaves it alone.
alter table models add column if not exists channel_override text
  check (channel_override in ('dealer', 'retail'));

-- The rules. Inputs are the stored manufacturer name, line and model number (prefixes like
-- Ricoh "IM" / HP "Managed" are stripped by the parser, so rules match what is stored).
create or replace function mm_channel(p_mfr text, p_line text, p_model text)
returns text language sql immutable set search_path = public as $$
  select case
    -- Konica Minolta and Ricoh don't sell consumer/retail product.
    when p_mfr in ('Konica Minolta', 'Ricoh') then 'dealer'
    -- HP: Managed devices (LaserJet / PageWide Managed, model numbers E#####) are dealer; the rest retail.
    when p_mfr = 'HP' then case when p_model ~* '^E\d{4,5}' then 'dealer' else 'retail' end
    -- Canon: imageRUNNER (and its successor imageFORCE, and imagePRESS production) are dealer;
    -- imageCLASS, PIXMA, imagePROGRAF and the rest are retail.
    when p_mfr = 'Canon' then case when p_line in ('IR', 'IFORCE', 'IPR') then 'dealer' else 'retail' end
    else null
  end
$$;

-- Rebuild the view with the two new columns. model_by_key (0008) returns its row type, so it is
-- dropped with the view and recreated below.
drop view if exists model_catalog cascade;

create view model_catalog as
select m.*, mf.name as manufacturer,
       (select count(*) from model_aliases a where a.model_id = m.id and a.status = 'linked') as alias_count,
       (select count(*) from model_variants v where v.model_id = m.id) as variant_count,
       (select count(*) from model_supplies s where s.model_id = m.id) as supply_count,
       coalesce(m.channel_override, mm_channel(mf.name, m.line, m.model)) as channel,
       case when m.channel_override is not null then 'override'
            when mm_channel(mf.name, m.line, m.model) is not null then 'rule' end as channel_source
from models m left join manufacturers mf on mf.id = m.manufacturer_id;

grant select on model_catalog to anon, authenticated;

create or replace function model_by_key(p_key text)
returns setof model_catalog
language sql stable security definer set search_path = public as $$
  select c.* from model_catalog c where c.id = (select r.model_id from resolve_key(upper(trim(p_key))) r limit 1)
$$;
grant execute on function model_by_key(text) to anon, authenticated;

commit;
