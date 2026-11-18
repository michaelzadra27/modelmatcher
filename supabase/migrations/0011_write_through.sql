-- ModelMaster · 0011 database functions for saving each change directly (no whole-copy Push).
-- All four are for signed-in users only (anon cannot call them) and run as the caller, so the
-- usual "authenticated full access" policies apply. Each runs as one transaction: it either
-- fully happens or not at all. Safe to re-run.

begin;

-- ── New MM keys ─────────────────────────────────────────────────────────────
-- Keys come from the database so two people (or two tabs) can never mint the same one.
-- The sequence is pulled up to the highest key in use (models and retired/redirected keys) on
-- every call, so keys minted any other way (an older app build's Push) never collide either.
create sequence if not exists model_key_seq;

create or replace function next_model_keys(p_count int default 1)
returns setof text
language plpgsql volatile set search_path = public as $$
declare
  hi bigint;
  cur bigint;
begin
  if p_count is null or p_count < 1 or p_count > 5000 then
    raise exception 'next_model_keys: count must be 1..5000 (got %)', p_count;
  end if;
  perform pg_advisory_xact_lock(hashtext('model_key_seq'));
  select coalesce(max(substring(k from '^MM-(\d+)$')::bigint), 0) into hi
  from (select canonical_key as k from models union all select old_key from model_redirects) x;
  select case when is_called then last_value else last_value - 1 end into cur from model_key_seq;
  if cur < hi then perform setval('model_key_seq', hi, true); end if;
  return query select 'MM-' || lpad(nextval('model_key_seq')::text, 6, '0') from generate_series(1, p_count);
end $$;

-- ── Merge one model into another ────────────────────────────────────────────
-- Names, variants and toner links move to the survivor; the retired key (and any keys that
-- already redirected to it) redirect to the survivor; the retired model is deleted.
create or replace function merge_models(p_from text, p_into text)
returns text
language plpgsql volatile set search_path = public as $$
declare
  f uuid;
  t uuid;
  t_key text;
  fv record;
  tv uuid;
begin
  select model_id into f from resolve_key(upper(trim(p_from)));
  select model_id, canonical_key into t, t_key from resolve_key(upper(trim(p_into)));
  if f is null then raise exception 'merge_models: % not found', p_from; end if;
  if t is null then raise exception 'merge_models: % not found', p_into; end if;
  if f = t then return t_key; end if;

  -- Variants: reuse the survivor's variant of the same name, else move the variant over.
  for fv in select id, variant from model_variants where model_id = f loop
    select id into tv from model_variants where model_id = t and variant = fv.variant;
    if tv is null then
      update model_variants set model_id = t where id = fv.id;
    else
      update model_aliases set variant_id = tv where variant_id = fv.id;
      delete from model_variants where id = fv.id;
    end if;
  end loop;

  update model_aliases set model_id = t where model_id = f;

  -- Toner links: the survivor keeps its own link where both have the same supply.
  insert into model_supplies (model_id, supply_id, source_id, cost, yield_pages)
  select t, supply_id, source_id, cost, yield_pages from model_supplies where model_id = f
  on conflict (model_id, supply_id) do nothing;

  update model_redirects set model_id = t where model_id = f;
  insert into model_redirects (old_key, model_id)
  select canonical_key, t from models where id = f
  on conflict (old_key) do update set model_id = excluded.model_id;

  delete from models where id = f; -- its remaining toner links go with it (cascade)
  return t_key;
end $$;

-- ── Delete a model ──────────────────────────────────────────────────────────
-- Its names go back to waiting for review (not left "linked" to nothing).
create or replace function delete_model(p_key text)
returns boolean
language plpgsql volatile set search_path = public as $$
declare m uuid;
begin
  select id into m from models where canonical_key = upper(trim(p_key));
  if m is null then return false; end if;
  update model_aliases set status = 'pending', model_id = null, variant_id = null
  where model_id = m and status = 'linked';
  delete from models where id = m;
  return true;
end $$;

-- ── Remove a source sheet ───────────────────────────────────────────────────
-- Its names and price list go (cascade). Its toner links are removed too: left alone they would
-- turn into source-less links, which read as BLI-captured supplies. Supplies nothing links to
-- afterwards are removed.
create or replace function delete_source(p_name text)
returns boolean
language plpgsql volatile set search_path = public as $$
declare
  s uuid;
  touched uuid[];
begin
  select id into s from sources where name = p_name;
  if s is null then return false; end if;
  select coalesce(array_agg(distinct supply_id), '{}') into touched from model_supplies where source_id = s;
  delete from model_supplies where source_id = s;
  delete from supplies x where x.id = any(touched)
    and not exists (select 1 from model_supplies ms where ms.supply_id = x.id);
  delete from sources where id = s;
  return true;
end $$;

revoke all on function next_model_keys(int), merge_models(text, text), delete_model(text), delete_source(text) from public, anon;
grant execute on function next_model_keys(int), merge_models(text, text), delete_model(text), delete_source(text) to authenticated;

commit;
