-- ModelMaster · 0009 sales channel: is a model sold through the dealer channel, retail, or unsure?
-- channel = channel_override (set per model) if present, else the rule in mm_channel(), else 'unsure'.
--   'dealer'  sold through the dealer / MPS channel
--   'retail'  sold retail / SMB (Amazon, office stores, distribution)
--   'unsure'  mixed lines, or nothing confident to go on. Never null.
-- channel_source = 'override' | 'rule' | 'default' (no rule matched), so callers can tell how sure it is.
-- Rules live in one function: change them with "create or replace function mm_channel" and every model
-- updates at once (nothing stored per model, nothing to Push). Safe to re-run, including over the
-- earlier two-bucket version of this file.

begin;

-- Per-model exception. Push never sends this column, so its upsert leaves it alone.
alter table models add column if not exists channel_override text;
alter table models drop constraint if exists models_channel_override_check;
alter table models add constraint models_channel_override_check
  check (channel_override in ('dealer', 'retail', 'unsure'));

-- The rules. Inputs are the stored manufacturer name, line and model number. The parser strips
-- series words and prefixes (Ricoh "IM", HP "Managed", Lexmark "MS"... stay; "LaserJet Pro" becomes
-- line LASERJET + M404), so rules match what is stored. Returns null when no rule applies.
create or replace function mm_channel(p_mfr text, p_line text, p_model text)
returns text language sql immutable set search_path = public as $$
  select case
    -- Copier/MFP makers with no retail line.
    when p_mfr in ('Konica Minolta', 'Ricoh', 'Sharp', 'Toshiba', 'Muratec') then 'dealer'

    -- HP: Managed (E + 4-5 digits, LaserJet and PageWide) is dealer. DeskJet/OfficeJet, LaserJet Pro
    -- (M1xx-M4xx, M1xxx, P/CP1xxx, the 3x01-4x03 Pro generation) and PageWide Pro are retail.
    -- LaserJet Enterprise, DesignJet, Latex, PageWide XL and the rest sell both ways.
    when p_mfr = 'HP' then case
      when m ~ '^E\d{4,5}(\D|$)' then 'dealer'
      when l in ('DESKJET', 'OFFICEJET') then 'retail'
      when l = 'PAGEWIDE' and m ~ '^PRO' then 'retail'
      when l = 'LASERJET' and (m ~ '^M[1-4]\d{2}(\D|$)' or m ~ '^M1\d{3}' or m ~ '^C?P1\d{3}' or m ~ '^[34]\d0[1-3](\D|$)') then 'retail'
      else 'unsure' end

    -- Canon: imageRUNNER, its successor imageFORCE, and imagePRESS are dealer. imageCLASS, PIXMA,
    -- MAXIFY are retail, as are line-less LBP/MF/TR/TS/G/GX/MB/iX/D models. imagePROGRAF and other
    -- line-less models (old NP copiers, scanners, wide format) are unsure.
    when p_mfr = 'Canon' then case
      when l in ('IR', 'IFORCE', 'IPR') then 'dealer'
      when l in ('ICLASS', 'PIXMA', 'MAXIFY') then 'retail'
      when l = '' and m ~ '^(LBP|MF|TR|TS|GX|MB|IX)\d' then 'retail'
      when l = '' and m ~ '^(G\d{3,4}|D1\d{3}|D5\d{2})(\D|$)' then 'retail'
      else 'unsure' end

    -- Xerox: AltaLink, PrimeLink (B9xxx/C9xxx), Color C60/C70/C75 and the A3 WorkCentre 5xxx/7xxx are
    -- dealer. The small B/C 2xx-4xx are retail. VersaLink, Phaser and the rest sell both ways.
    when p_mfr = 'Xerox' then case
      when l = 'ALTALINK' then 'dealer'
      when l = '' and m ~ '^([BC]9\d{3}|C60|C70|C75)(\D|$)' then 'dealer'
      when l = 'WORKCENTRE' and m ~ '^[57]\d{3}(\D|$)' then 'dealer'
      when l = '' and m ~ '^[BC][234]\d{2}(\D|$)' then 'retail'
      else 'unsure' end

    -- Kyocera: TASKalfa (and Copystar, stored as TASKalfa) is dealer; ECOSYS and older FS/KM unsure.
    when p_mfr = 'Kyocera' then case when l = 'TASKALFA' then 'dealer' else 'unsure' end

    -- Lexmark: the 4-digit contract twins of the standard models (XC/XM/M/C/B/MB/MC + 4 digits, e.g.
    -- M3250 = MS621, XM3250 = MX622) are dealer, except the retail "Go Line" entry models. The standard
    -- 3-digit CS/CX/MS/MX, legacy and vertical (ST/XS/TS/ES) models sell both ways.
    when p_mfr = 'Lexmark' then case
      when m ~ '^(B2236|MB2236|C3224|C3326|C3426|MC3224|MC3326|MC3426)(\D|$)' then 'retail'
      when m ~ '^(XC|XM|MB|MC|B|C|M)\d{4}(\D|$)' then 'dealer'
      else 'unsure' end

    -- Samsung: MultiXpress A3 (K/X + 4 digits, CLX-8xxx/9xxx, M4370/M5370) is dealer; the rest retail.
    when p_mfr = 'Samsung' then case
      when m ~ '^([KX]\d{4}|CLX[89]\d{3}|SCX8\d{3}|M[45]370)(\D|$)' then 'dealer'
      else 'retail' end

    -- Epson: WorkForce Enterprise (C/M + 5 digits, e.g. WF-C21000) is dealer; SureColor, line-less
    -- large-format (P/T/F + 4-5 digits) and ColorWorks label printers (C + 3-4 digits) are unsure; the rest retail.
    when p_mfr = 'Epson' then case
      when m ~ '^(WF-?)?[CM]\d{5}(\D|$)' then 'dealer'
      when l = 'SURECOLOR' then 'unsure'
      when l = '' and m ~ '^([PTF]\d{4,5}|C\d{3,4})(\D|$)' then 'unsure'
      else 'retail' end

    when p_mfr in ('Brother', 'Dell', 'Pantum') then 'retail'
    else null
  end
  from (select upper(coalesce(p_model, '')) as m, upper(coalesce(p_line, '')) as l) x
$$;

-- Rebuild the view with the two new columns. model_by_key (0008) returns its row type, so it is
-- dropped with the view and recreated below.
drop view if exists model_catalog cascade;

create view model_catalog as
select m.*, mf.name as manufacturer,
       (select count(*) from model_aliases a where a.model_id = m.id and a.status = 'linked') as alias_count,
       (select count(*) from model_variants v where v.model_id = m.id) as variant_count,
       (select count(*) from model_supplies s where s.model_id = m.id) as supply_count,
       coalesce(m.channel_override, mm_channel(mf.name, m.line, m.model), 'unsure') as channel,
       case when m.channel_override is not null then 'override'
            when mm_channel(mf.name, m.line, m.model) is not null then 'rule'
            else 'default' end as channel_source
from models m left join manufacturers mf on mf.id = m.manufacturer_id;

grant select on model_catalog to anon, authenticated;

create or replace function model_by_key(p_key text)
returns setof model_catalog
language sql stable security definer set search_path = public as $$
  select c.* from model_catalog c where c.id = (select r.model_id from resolve_key(upper(trim(p_key))) r limit 1)
$$;
grant execute on function model_by_key(text) to anon, authenticated;

commit;
