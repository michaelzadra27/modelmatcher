-- BLI device specs on the canonical model. Run after 0002_toner.sql.
--
-- Merges the old PrinterAPI "devices" attributes onto models, keyed by the same MM- id.
-- Core queryable fields are columns; the long tail stays in models.attributes (jsonb).

alter table models add column if not exists full_name                text;
alter table models add column if not exists device_class             text;    -- printer|mfp|copier|scanner|production|fax
alter table models add column if not exists color_capability         text;    -- color|mono
alter table models add column if not exists technology               text;    -- laser|inkjet|led|...
alter table models add column if not exists part_number              text;
alter table models add column if not exists street_price             numeric(10, 2);
alter table models add column if not exists srp_price                numeric(10, 2);
alter table models add column if not exists intro_date               text;
alter table models add column if not exists manufacturing_status     text;    -- active|discontinued
alter table models add column if not exists discontinued_date        text;
alter table models add column if not exists estimated_end_of_support text;
alter table models add column if not exists speed_ppm                integer;
alter table models add column if not exists speed_raw                text;
alter table models add column if not exists first_copy_out_sec       numeric(6, 2);
alter table models add column if not exists scan_speed_simplex_black integer;
alter table models add column if not exists scan_speed_simplex_color integer;
alter table models add column if not exists scan_speed_duplex_black  integer;
alter table models add column if not exists scan_speed_duplex_color  integer;
alter table models add column if not exists document_feeder          text;
alter table models add column if not exists scanner_feeder_type      text;    -- single-pass|reversing
alter table models add column if not exists fax_capable              boolean;
alter table models add column if not exists has_ethernet             boolean;
alter table models add column if not exists has_wifi                 boolean;
alter table models add column if not exists has_nfc                  boolean;
alter table models add column if not exists network_interface_raw    text;
alter table models add column if not exists max_paper_size           text;
alter table models add column if not exists paper_size_class         text;    -- A3|A4
alter table models add column if not exists bli_confidence           numeric(4, 2);
alter table models add column if not exists raw_spec                 text;    -- pasted BLI text, for provenance/re-parse
alter table models add column if not exists has_spec                 boolean not null default false; -- true once BLI-captured

create index if not exists idx_models_device_class on models(device_class);
create index if not exists idx_models_has_spec on models(has_spec) where has_spec;

-- Supplies gain the provenance fields BLI parses (coverage, raw line).
alter table supplies add column if not exists part_number text;
alter table supplies add column if not exists coverage    text;

-- Full device view other apps read: identity + BLI specs in one row.
create or replace view device_catalog as
select m.*, mf.name as manufacturer_name,
       (select count(*) from model_supplies ms where ms.model_id = m.id) as supply_count,
       (select count(*) from model_aliases a where a.model_id = m.id and a.status = 'linked') as alias_count
from models m left join manufacturers mf on mf.id = m.manufacturer_id;
