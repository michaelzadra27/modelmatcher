-- ModelMaster · 0010 remove duplicated review-log rows.
-- Until the fix that ships with this file, every Push re-inserted the whole local review log but
-- only cleared the rows for the sheets being pushed, so entries from other sources (BLI Capture,
-- merges, sheets no longer loaded) were copied again on each push. Keeps the oldest row of each
-- identical (source, name, decision, model, date) group. Safe to re-run.

delete from review_log
where id in (
  select id from (
    select id, row_number() over (partition by source, raw_name, decision, model_key, decided_on order by id) as rn
    from review_log
  ) x
  where rn > 1
);

-- Report what is left.
select count(*) as review_log_rows from review_log;
