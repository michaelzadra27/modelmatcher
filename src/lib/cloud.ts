import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { parse } from './normalize'
import { rowCtx } from './match'
import { Canonical, IGNORE, Role, Row, State, emptyState, linkKey } from './types'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const cloudConfigured = Boolean(url && anon && !url.includes('YOUR-PROJECT'))
export const supabase: SupabaseClient | null = cloudConfigured ? createClient(url!, anon!) : null

type Progress = (msg: string) => void

const chunks = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n))

async function must<T>(q: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await q
  if (error) throw new Error(`${what}: ${error.message}`)
  return (data ?? ([] as unknown)) as T
}

const toInt = (s: string) => {
  const n = parseInt(s.replace(/[^\d-]/g, ''), 10)
  return Number.isFinite(n) ? n : null
}
const toPrice = (s: string) => {
  const n = parseFloat(s.replace(/[^\d.\-]/g, ''))
  return Number.isFinite(n) ? n : null
}
const splitList = (s: string) => s.split(/[;,\n]+/).map((x) => x.trim()).filter(Boolean)

/** Push the working state to Supabase. Idempotent: natural keys + upserts, so re-pushing is safe. */
export async function push(state: State, say: Progress): Promise<string> {
  const sb = supabase!
  const canon = state.canonicals
  const roles = (s: string, c: string): Role => state.sources[s].roles[c]

  say('Manufacturers…')
  const mfrNames = [...new Set(canon.map((c) => c.manufacturer).filter(Boolean))]
  const mfrRows = await must(sb.from('manufacturers').upsert(mfrNames.map((name) => ({ name })), { onConflict: 'name' }).select('id,name'), 'manufacturers')
  const mfrId = new Map(mfrRows.map((r: any) => [r.name, r.id as string]))

  say(`Models (${canon.length})…`)
  const modelId = new Map<string, string>()
  for (const part of chunks(canon, 500)) {
    const rows = await must(
      sb.from('models').upsert(
        part.map((c) => ({
          canonical_key: c.id,
          manufacturer_id: mfrId.get(c.manufacturer) ?? null,
          model: c.model,
          family: c.family || null,
          device_type: c.deviceType || null,
          ppm: toInt(c.ppm),
          color: c.color || null,
          paper_size: c.paper || null,
          toner_family: c.toner || null,
          notes: c.notes || null,
        })),
        { onConflict: 'canonical_key' }
      ).select('id,canonical_key'),
      'models'
    )
    rows.forEach((r: any) => modelId.set(r.canonical_key, r.id))
  }

  say('Sources…')
  const srcNames = Object.keys(state.sources)
  const srcRows = await must(
    sb.from('sources').upsert(
      srcNames.map((name) => ({ name, is_master: state.master === name, column_roles: state.sources[name].roles, last_imported_at: new Date().toISOString() })),
      { onConflict: 'name' }
    ).select('id,name'),
    'sources'
  )
  const sourceId = new Map(srcRows.map((r: any) => [r.name, r.id as string]))

  // Variants come from linked aliases whose name carries a suffix (FDW, DN, ...).
  say('Variants…')
  const variantPairs = new Map<string, { model_id: string; variant: string }>()
  const aliasVariant = new Map<string, string>() // linkKey → variant
  for (const s of Object.values(state.sources))
    for (const r of s.rows) {
      const lk = linkKey(s.name, r.raw)
      const link = state.links[lk]
      if (!link || link === IGNORE || !modelId.has(link)) continue
      const v = parse(r.raw, rowCtx(s, r)).variant
      if (!v) continue
      aliasVariant.set(lk, v)
      variantPairs.set(`${link}|${v}`, { model_id: modelId.get(link)!, variant: v })
    }
  const variantId = new Map<string, string>() // `${model_id}|${variant}` → id
  for (const part of chunks([...variantPairs.values()], 500)) {
    const rows = await must(sb.from('model_variants').upsert(part, { onConflict: 'model_id,variant' }).select('id,model_id,variant'), 'variants')
    rows.forEach((r: any) => variantId.set(`${r.model_id}|${r.variant}`, r.id))
  }

  // Aliases: every name, linked or not, so the whole queue lives in the database.
  type AliasOut = { source_id: string; raw_name: string; model_id: string | null; variant_id: string | null; status: string; row_count: number; attributes: Record<string, string> }
  const aliasOut: AliasOut[] = []
  const meta = new Map<string, { source: string; row: Row; link: string | undefined }>()
  for (const s of Object.values(state.sources))
    for (const r of s.rows) {
      const lk = linkKey(s.name, r.raw)
      const link = state.links[lk]
      const mid = link && link !== IGNORE ? modelId.get(link) ?? null : null
      const v = aliasVariant.get(lk)
      aliasOut.push({
        source_id: sourceId.get(s.name)!,
        raw_name: r.raw,
        model_id: mid,
        variant_id: mid && v ? variantId.get(`${mid}|${v}`) ?? null : null,
        status: link === IGNORE ? 'ignored' : mid ? 'linked' : 'pending',
        row_count: r.count,
        attributes: Object.fromEntries(Object.entries(r.attrs).filter(([c]) => s.roles[c] !== 'ignore')),
      })
      meta.set(`${sourceId.get(s.name)}\u0001${r.raw}`, { source: s.name, row: r, link })
    }
  say(`Aliases (${aliasOut.length.toLocaleString()})…`)
  const aliasId = new Map<string, string>() // `${source_id}\u0001${raw}` → id
  let done = 0
  for (const part of chunks(aliasOut, 500)) {
    const rows = await must(sb.from('model_aliases').upsert(part, { onConflict: 'source_id,raw_name' }).select('id,source_id,raw_name'), 'aliases')
    rows.forEach((r: any) => aliasId.set(`${r.source_id}\u0001${r.raw_name}`, r.id))
    done += part.length
    say(`Aliases ${done.toLocaleString()} / ${aliasOut.length.toLocaleString()}…`)
  }

  // Supplies: every SKU found in a "supply" column of a linked alias, tied to that alias's model.
  say('Supplies…')
  const skuSet = new Set<string>()
  const msPairs = new Map<string, { model_id: string; sku: string; source_id: string }>()
  for (const s of Object.values(state.sources)) {
    const supplyCols = s.columns.filter((c) => s.roles[c] === 'supply')
    if (!supplyCols.length) continue
    for (const r of s.rows) {
      const link = state.links[linkKey(s.name, r.raw)]
      const mid = link && link !== IGNORE ? modelId.get(link) : undefined
      if (!mid) continue
      for (const c of supplyCols)
        for (const sku of splitList(r.attrs[c] ?? '')) {
          skuSet.add(sku)
          msPairs.set(`${mid}|${sku}`, { model_id: mid, sku, source_id: sourceId.get(s.name)! })
        }
    }
  }
  const supplyId = new Map<string, string>()
  for (const part of chunks([...skuSet], 500)) {
    const rows = await must(sb.from('supplies').upsert(part.map((sku) => ({ sku })), { onConflict: 'sku', ignoreDuplicates: true }).select('id,sku'), 'supplies')
    rows.forEach((r: any) => supplyId.set(r.sku, r.id))
  }
  // ignoreDuplicates returns only new rows; fetch ids for the SKUs that already existed.
  const missing = [...skuSet].filter((k) => !supplyId.has(k))
  for (const part of chunks(missing, 200)) {
    const rows = await must(sb.from('supplies').select('id,sku').in('sku', part), 'supplies lookup')
    rows.forEach((r: any) => supplyId.set(r.sku, r.id))
  }
  const msRows = [...msPairs.values()].map((p) => ({ model_id: p.model_id, supply_id: supplyId.get(p.sku)!, source_id: p.source_id })).filter((r) => r.supply_id)
  for (const part of chunks(msRows, 500)) await must(sb.from('model_supplies').upsert(part, { onConflict: 'model_id,supply_id' }), 'model_supplies')

  // Price book: one entry per alias × price column, priced as written in the source.
  say('Prices…')
  let priceCount = 0
  for (const s of Object.values(state.sources)) {
    const priceCols = s.columns.filter((c) => s.roles[c] === 'price')
    if (!priceCols.length) continue
    const [pl] = await must(sb.from('price_lists').upsert({ source_id: sourceId.get(s.name), name: s.name }, { onConflict: 'source_id,name' }).select('id'), 'price list')
    const entries: object[] = []
    for (const r of s.rows) {
      const aid = aliasId.get(`${sourceId.get(s.name)}\u0001${r.raw}`)
      if (!aid) continue
      for (const c of priceCols) {
        const price = toPrice(r.attrs[c] ?? '')
        if (price != null) entries.push({ price_list_id: (pl as any).id, alias_id: aid, price_type: c, price })
      }
    }
    for (const part of chunks(entries, 500)) await must(sb.from('price_entries').upsert(part, { onConflict: 'price_list_id,alias_id,price_type' }), 'price entries')
    priceCount += entries.length
  }

  if (state.deleted.length) {
    say('Deleting removed models…')
    for (const part of chunks(state.deleted, 100)) await must(sb.from('models').delete().in('canonical_key', part), 'delete models')
  }

  // Review log: replace the stored entries for the sources being pushed with the local log.
  say('Review log…')
  if (state.log.length) {
    await must(sb.from('review_log').delete().in('source', srcNames), 'log reset')
    for (const part of chunks(state.log, 500))
      await must(sb.from('review_log').insert(part.map((l) => ({ source: l.source, raw_name: l.raw, decision: l.decision, model_key: l.canonicalId || null, decided_on: l.date }))), 'review log')
  }

  return `Pushed ${canon.length} models, ${aliasOut.length.toLocaleString()} aliases, ${skuSet.size} supply SKUs, ${priceCount.toLocaleString()} prices.`
}

/** Pull the working state from Supabase. */
export async function pull(say: Progress): Promise<State> {
  const sb = supabase!
  const next = emptyState()

  say('Models…')
  const models: any[] = []
  for (let from = 0; ; from += 1000) {
    const rows = await must(sb.from('models').select('id,canonical_key,model,family,device_type,ppm,color,paper_size,toner_family,notes,manufacturers(name)').range(from, from + 999), 'models')
    models.push(...rows)
    if (rows.length < 1000) break
  }
  const keyById = new Map<string, string>()
  for (const m of models) {
    keyById.set(m.id, m.canonical_key)
    next.canonicals.push({
      id: m.canonical_key,
      manufacturer: m.manufacturers?.name ?? '',
      model: m.model,
      family: m.family ?? '',
      deviceType: m.device_type ?? '',
      ppm: m.ppm == null ? '' : String(m.ppm),
      color: m.color ?? '',
      paper: m.paper_size ?? '',
      toner: m.toner_family ?? '',
      notes: m.notes ?? '',
    } satisfies Canonical)
  }

  say('Sources…')
  const srcs = await must(sb.from('sources').select('id,name,column_roles,is_master'), 'sources')
  const nameById = new Map<string, string>()
  for (const s of srcs as any[]) {
    nameById.set(s.id, s.name)
    if (s.is_master) next.master = s.name
    next.sources[s.name] = { name: s.name, columns: Object.keys(s.column_roles ?? {}), roles: { ...(s.column_roles ?? {}) }, rows: [] }
  }

  const aliases: any[] = []
  for (let from = 0; ; from += 1000) {
    say(`Aliases ${aliases.length.toLocaleString()}…`)
    const rows = await must(sb.from('model_aliases').select('source_id,raw_name,model_id,status,row_count,attributes').order('id').range(from, from + 999), 'aliases')
    aliases.push(...rows)
    if (rows.length < 1000) break
  }
  for (const a of aliases) {
    const src = next.sources[nameById.get(a.source_id)!]
    if (!src) continue
    const attrs = (a.attributes ?? {}) as Record<string, string>
    for (const c of Object.keys(attrs)) if (!src.columns.includes(c)) { src.columns.push(c); src.roles[c] ??= 'linked' as Role }
    src.rows.push({ raw: a.raw_name, count: a.row_count, attrs })
    if (a.status === 'ignored') next.links[linkKey(src.name, a.raw_name)] = IGNORE
    else if (a.status === 'linked' && a.model_id && keyById.has(a.model_id)) next.links[linkKey(src.name, a.raw_name)] = keyById.get(a.model_id)!
  }

  say('Review log…')
  const log: any[] = []
  for (let from = 0; ; from += 1000) {
    const rows = await must(sb.from('review_log').select('source,raw_name,decision,model_key,decided_on').order('id').range(from, from + 999), 'review log')
    log.push(...rows)
    if (rows.length < 1000) break
  }
  next.log = log.map((l) => ({ date: l.decided_on ?? '', source: l.source ?? '', raw: l.raw_name ?? '', decision: l.decision, canonicalId: l.model_key ?? '' }))
  return next
}
