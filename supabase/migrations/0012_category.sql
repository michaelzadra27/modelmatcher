-- ModelMaster · 0012 device category: is a model an ordinary office printer/MFP, or a specialty
-- device that is its own business (wide format, label/thermal)?
--   'standard'     office printers and MFPs (the default)
--   'wide-format'  plotters, large-format, sign & display (DesignJet, imagePROGRAF, PlotWave, Latex…)
--   'label'        label, thermal, receipt and card printers (Zebra, SATO, Honeywell, ColorWorks…)
-- category = category_override (set per model) if present, else the rule in mm_category(), else 'standard'.
-- category_source = 'override' | 'rule' | 'default'. Separate from channel (0009): a wide-format
-- device can be dealer or retail. Rules live in one function, as with channel. Safe to re-run.

begin;

alter table models add column if not exists category_override text;
alter table models drop constraint if exists models_category_override_check;
alter table models add constraint models_category_override_check
  check (category_override in ('standard', 'wide-format', 'label'));

-- Returns null when no rule applies (the model is then 'standard').
create or replace function mm_category(p_mfr text, p_line text, p_model text)
returns text language sql immutable set search_path = public as $$
  select case
    -- Label / thermal / card makers.
    when p_mfr in ('Zebra', 'Fargo') then 'label'
    -- Wide-format makers.
    when p_mfr = 'KIP' then 'wide-format'

    when p_mfr = 'Canon' then case
      when l = 'IPF' then 'wide-format'                                     -- imagePROGRAF
      when l = '' and m ~ '^(TX|TM|TZ|TA|TC|GP)-?\d' then 'wide-format'     -- imagePROGRAF stored without its line
      end

    when p_mfr = 'HP' then case
      when l in ('DESIGNJET', 'LATEX') then 'wide-format'
      when l = 'PAGEWIDE' and m ~ '^XL' then 'wide-format'                  -- PageWide XL
      end

    when p_mfr = 'Epson' then case
      when l = 'SURECOLOR' then 'wide-format'
      when l = '' and m ~ '^[PTF]\d{4,5}(\D|$)' then 'wide-format'          -- SureColor SC-P/T/F
      when m ~ '^C(3500|4000|6000|6500|7500|8000)(\D|$)' then 'label'      -- ColorWorks CW-C… (not ST-/WF-C business inkjets)
      end

    when p_mfr = 'Oce' then case when m ~ '^(PLOTWAVE|COLORWAVE)' then 'wide-format' end

    when p_mfr = 'Xerox' then case when l = '' and m ~ '^(6204|6279)(\D|$)' then 'wide-format' end

    -- Brands the parser doesn't know (Honeywell/Intermec, SATO, Godex, Citizen, Printronix, VIPColor,
    -- Afinia) land under Generic/Lomond; their model numbers are distinctive enough.
    when p_mfr in ('Generic', 'Lomond', 'Unknown') then case
      when m ~ '^(PM4\d|PC4\d|PD4\d|PX\d|RP\d|CL[46]|S8\d|CT4|GL\d{3}|T[4-8]\d{3}|E300|VP\d{3}|L901|CP950)' then 'label'
      end
  end
  from (select upper(coalesce(p_model, '')) as m, upper(coalesce(p_line, '')) as l) x
$$;

-- Rebuild the view with the two new columns (model_by_key depends on its row type).
drop view if exists model_catalog cascade;

create view model_catalog as
select m.*, mf.name as manufacturer,
       (select count(*) from model_aliases a where a.model_id = m.id and a.status = 'linked') as alias_count,
       (select count(*) from model_variants v where v.model_id = m.id) as variant_count,
       (select count(*) from model_supplies s where s.model_id = m.id) as supply_count,
       coalesce(m.channel_override, mm_channel(mf.name, m.line, m.model), 'unsure') as channel,
       case when m.channel_override is not null then 'override'
            when mm_channel(mf.name, m.line, m.model) is not null then 'rule'
            else 'default' end as channel_source,
       coalesce(m.category_override, mm_category(mf.name, m.line, m.model), 'standard') as category,
       case when m.category_override is not null then 'override'
            when mm_category(mf.name, m.line, m.model) is not null then 'rule'
            else 'default' end as category_source
from models m left join manufacturers mf on mf.id = m.manufacturer_id;

grant select on model_catalog to anon, authenticated;

create or replace function model_by_key(p_key text)
returns setof model_catalog
language sql stable security definer set search_path = public as $$
  select c.* from model_catalog c where c.id = (select r.model_id from resolve_key(upper(trim(p_key))) r limit 1)
$$;
grant execute on function model_by_key(text) to anon, authenticated;

-- Label printers stored under the wrong manufacturer (HP), which no brand rule can safely catch:
-- tagged one by one. Matched by key and model, so a key reused differently is left alone.
update models m set category_override = 'label'
from (values 
  ('MM-001241', 'ZD621'),
  ('MM-001125', 'PM45:J10'),
  ('MM-001163', 'PX240S:F10'),
  ('MM-001124', 'PM43:P10'),
  ('MM-000990', 'M10'),
  ('MM-001101', 'ME240'),
  ('MM-000789', '300'),
  ('MM-001164', 'RP4F:M10'),
  ('MM-001123', 'PD45:F10'),
  ('MM-001121', 'PC43D:K10'),
  ('MM-001122', 'PC45D:C10'),
  ('MM-001192', 'T6204')
) v(k, mdl)
where m.canonical_key = v.k and m.model = v.mdl and m.category_override is null;

commit;
