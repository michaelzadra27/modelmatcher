-- ModelMaster · 0005: rebuild model_catalog so it carries the BLI spec columns added in 0003.
-- A view's `m.*` is expanded when the view is created, so model_catalog (from 0001) never saw them.
-- Dropped and recreated (not "create or replace", which can't insert columns before existing ones).
-- Same columns as before plus the spec fields; safe to re-run.

begin;

drop view if exists model_catalog;

create view model_catalog as
select m.*, mf.name as manufacturer,
       (select count(*) from model_aliases a where a.model_id = m.id and a.status = 'linked') as alias_count,
       (select count(*) from model_variants v where v.model_id = m.id) as variant_count,
       (select count(*) from model_supplies s where s.model_id = m.id) as supply_count
from models m left join manufacturers mf on mf.id = m.manufacturer_id;

-- Readable by the public key, like before (consistent with the open lookups in 0004).
grant select on model_catalog to anon, authenticated;

commit;
