-- ModelMaster · 0008 batch lookup + key-based reads, callable with the public key.
-- Used by client/modelmaster.ts. Safe to re-run.

-- Many names in one call (a usage report). Each distinct (name, manufacturer) is looked up once;
-- every input row comes back, in order, with its best match (nulls when nothing matched) and the
-- runner-up's confidence, so callers can flag close calls (e.g. confidence - runner_up < 0.05).
create or replace function lookup_models(p_names text[], p_mfrs text[] default null)
returns table (idx int, name text, canonical_key text, model_id uuid, manufacturer text, model text, line text,
               generation text, variant text, confidence numeric, method text, runner_up numeric)
language sql stable security definer set search_path = public, extensions as $$
  with inp as (
    select x.i::int as i, x.n, nullif(trim(coalesce(p_mfrs[x.i], '')), '') as m
    from unnest(p_names[1:5000]) with ordinality as x(n, i)
  ),
  u as (select distinct n, m from inp where coalesce(trim(n), '') <> ''),
  res as (
    select u.n, u.m, l.*, row_number() over (partition by u.n, u.m order by l.confidence desc, l.canonical_key) as rk
    from u cross join lateral lookup_model(u.n, u.m, 2) l
  )
  select inp.i, inp.n, r1.canonical_key, r1.model_id, r1.manufacturer, r1.model, r1.line, r1.generation,
         r1.variant, r1.confidence, r1.method, r2.confidence
  from inp
  left join res r1 on r1.n = inp.n and r1.m is not distinct from inp.m and r1.rk = 1
  left join res r2 on r2.n = inp.n and r2.m is not distinct from inp.m and r2.rk = 2
  order by inp.i
$$;

-- One model by MM key, following merge redirects (an old key keeps working).
create or replace function model_by_key(p_key text)
returns setof model_catalog
language sql stable security definer set search_path = public as $$
  select c.* from model_catalog c where c.id = (select r.model_id from resolve_key(upper(trim(p_key))) r limit 1)
$$;

-- Toners/supplies for an MM key, following merge redirects.
create or replace function toners_for_key(p_key text)
returns setof model_toners
language sql stable security definer set search_path = public as $$
  select t.* from model_toners t where t.model_id = (select r.model_id from resolve_key(upper(trim(p_key))) r limit 1)
  order by t.type, t.color, t.sku
$$;

grant execute on function lookup_models(text[], text[]), model_by_key(text), toners_for_key(text) to anon, authenticated;
