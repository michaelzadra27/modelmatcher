-- ModelMaster · 0014 device category 'other': not an office printer.
-- Line and dot-matrix printers, envelope and production presses, scanners. Like 'wide-format' and
-- 'label', it's set per model with category_override (there is no rule for it in mm_category()), and
-- consumers such as ReplaceTheBase keep these devices out of toner spend and replacement savings.
--
-- Already applied to the live database by ReplaceTheBase's docs/data-fixes/catalog-fixes-2026-11-22.sql;
-- this records it so a rebuilt database matches. Safe to re-run.

begin;

alter table models drop constraint if exists models_category_override_check;
alter table models add constraint models_category_override_check
  check (category_override in ('standard', 'wide-format', 'label', 'other'));

commit;
