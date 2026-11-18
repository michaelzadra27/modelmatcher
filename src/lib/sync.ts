/**
 * Saving straight to the cloud. Every change made in the app is applied to the local copy at once
 * (so the screen updates instantly) and queued here as a small description of what changed ("these
 * names in this sheet", "this model's line field"). The queue runs one change at a time against
 * Supabase, reading the *current* local copy when it runs, so a later edit is never undone by an
 * earlier one. The queue is kept in IndexedDB: a change made just before closing the tab is sent
 * the next time the app opens. The local copy is only a cache of the cloud (see refresh()).
 */
import { useSyncExternalStore } from 'react'
import { parse } from './normalize'
import { rowCtx } from './match'
import { extractToners, sourceHasToners } from './toner'
import { skuKey } from './sku'
import { chunks, cloudConfigured, must, pull, pushCapture, specColumns, supabase, toInt, toPrice } from './cloud'
import { idbGet, idbSet } from './idb'
import { Canonical, IGNORE, LogEntry, Row, State, linkKey } from './types'

export type Op =
  | { t: 'models'; ids: string[]; fields: (keyof Canonical)[] | 'all' }
  | { t: 'names'; source: string; raws: string[] }
  | { t: 'sheet'; name: string }
  | { t: 'sources' }
  | { t: 'log'; entries: LogEntry[] }
  | { t: 'merge'; from: string; into: string }
  | { t: 'deleteModel'; id: string }
  | { t: 'deleteSource'; name: string }
  | { t: 'capture'; id: string; name: string }

const QKEY = 'modelmaster.queue'

// Wired up by the store (avoids an import cycle at module-evaluation time).
let getState: () => State = () => { throw new Error('sync not initialised') }
let replaceState: (next: State) => void = () => {}

let queue: Op[] = []
let running = false
let timer: number | undefined
let retryTimer: number | undefined
let retryDelay = 5000

// ── Status the UI shows ─────────────────────────────────────────────────────
export interface SyncStatus {
  /** Signed in, so changes are allowed and saved. */
  canWrite: boolean
  email: string | null
  pending: number
  saving: boolean
  error: string
  refreshing: boolean
  lastRefresh: string
}
let status: SyncStatus = { canWrite: false, email: null, pending: 0, saving: false, error: '', refreshing: false, lastRefresh: '' }
const listeners = new Set<() => void>()
function setStatus(p: Partial<SyncStatus>) {
  status = { ...status, ...p, pending: queue.length }
  listeners.forEach((l) => l())
}
export const getSyncStatus = () => status
export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore((cb) => (listeners.add(cb), () => listeners.delete(cb)), () => status)
}
export const canWrite = () => status.canWrite

// ── Queue ───────────────────────────────────────────────────────────────────
const persistQueue = () => idbSet(QKEY, queue).catch(() => {})

/** Queue changes. Consecutive changes to the same thing are folded into one. */
export function enqueue(...ops: Op[]) {
  for (const op of ops) {
    const last = running ? (queue.length > 1 ? queue[queue.length - 1] : undefined) : queue[queue.length - 1]
    if (last && fold(last, op)) continue
    queue.push(op)
  }
  persistQueue()
  setStatus({})
  window.clearTimeout(timer)
  timer = window.setTimeout(run, 400)
}

function fold(last: Op, op: Op): boolean {
  if (last.t === 'models' && op.t === 'models' && last.ids.length === 1 && op.ids.length === 1 && last.ids[0] === op.ids[0]) {
    last.fields = last.fields === 'all' || op.fields === 'all' ? 'all' : [...new Set([...last.fields, ...op.fields])]
    return true
  }
  if (last.t === 'names' && op.t === 'names' && last.source === op.source) {
    last.raws = [...new Set([...last.raws, ...op.raws])]
    return true
  }
  if (last.t === 'log' && op.t === 'log') {
    last.entries.push(...op.entries)
    return true
  }
  if ((last.t === 'sheet' && op.t === 'sheet' && last.name === op.name) || (last.t === 'sources' && op.t === 'sources')) return true
  return false
}

async function run() {
  if (running || !queue.length || !status.canWrite) return
  running = true
  setStatus({ saving: true })
  while (queue.length && status.canWrite) {
    try {
      await apply(queue[0], getState())
      queue.shift()
      persistQueue()
      retryDelay = 5000
      setStatus({ error: '' })
    } catch (e) {
      setStatus({ error: (e as Error).message })
      window.clearTimeout(retryTimer)
      retryTimer = window.setTimeout(run, retryDelay)
      retryDelay = Math.min(retryDelay * 3, 120000)
      break
    }
  }
  running = false
  setStatus({ saving: false })
  if (!queue.length) idle.splice(0).forEach((r) => r())
}

const idle: (() => void)[] = []
/** Resolves once every queued change is saved (rejects with the error if the queue is stuck). */
export function flush(): Promise<void> {
  if (!queue.length) return Promise.resolve()
  return new Promise((resolve, reject) => {
    idle.push(resolve)
    const check = window.setInterval(() => {
      if (!queue.length) return window.clearInterval(check)
      if (status.error && !running) { window.clearInterval(check); reject(new Error(status.error)) }
    }, 300)
  })
}

export function retryNow() {
  window.clearTimeout(retryTimer)
  retryDelay = 5000
  run()
}
/** Drop the change that keeps failing, then reload from the cloud so this copy matches it again. */
export async function discardStuck() {
  queue.shift()
  persistQueue()
  setStatus({ error: '' })
  if (queue.length) run()
  else await refresh(true)
}

// ── Keys ────────────────────────────────────────────────────────────────────
/** New MM keys from the database (never minted locally, so two people can't collide). */
export async function reserveKeys(n: number): Promise<string[]> {
  const rows = await must(supabase!.rpc('next_model_keys', { p_count: n }), 'new model keys')
  return (rows as any[]).map((r) => (typeof r === 'string' ? r : r.next_model_keys))
}

// ── Refresh: reload the cache from the cloud ────────────────────────────────
let stateVersion = 0
export const bumpVersion = () => stateVersion++

/**
 * Replace the local copy with the cloud's. Waits for unsaved changes first, and skips when an
 * import is still being previewed (it would be thrown away) unless `force`. If anything changes
 * locally while it loads, the result is dropped (it would undo that change) and retried shortly.
 */
export async function refresh(force = false): Promise<boolean> {
  if (!status.canWrite || status.refreshing) return false
  const st = getState()
  if (!force && st.pendingImport.length) return false
  setStatus({ refreshing: true })
  try {
    await flush()
    const v = stateVersion
    const next = await pull(() => {})
    if (v !== stateVersion) {
      window.setTimeout(() => refresh(), 5000)
      return false
    }
    replaceState({ ...next, keyPool: getState().keyPool, pendingImport: [], heldLog: [], dirty: false })
    setStatus({ lastRefresh: new Date().toISOString() })
    return true
  } catch (e) {
    setStatus({ error: `Couldn't refresh from the cloud: ${(e as Error).message}` })
    return false
  } finally {
    setStatus({ refreshing: false })
  }
}

// ── Start-up ────────────────────────────────────────────────────────────────
let started = false
export async function initSync(get: () => State, replace: (next: State) => void) {
  getState = get
  replaceState = replace
  if (started || !cloudConfigured || !supabase) return
  started = true
  queue = ((await idbGet<Op[]>(QKEY).catch(() => undefined)) ?? []) as Op[]
  const onSession = (email: string | null) => {
    const was = status.canWrite
    setStatus({ canWrite: !!email, email })
    if (email && !was) {
      run()
      refresh()
    }
  }
  const { data } = await supabase.auth.getSession()
  onSession(data.session?.user.email ?? null)
  supabase.auth.onAuthStateChange((_e, s) => onSession(s?.user.email ?? null))
  // See the other person's changes: refresh when coming back to the tab (at most once a minute).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (!status.lastRefresh || Date.now() - Date.parse(status.lastRefresh) > 60000) refresh()
  })
}

// ── Applying one change ─────────────────────────────────────────────────────
async function apply(op: Op, st: State): Promise<void> {
  const sb = supabase!
  switch (op.t) {
    case 'models':
      return saveModels(st, op.ids, op.fields)
    case 'names':
      return saveSheet(st, op.source, op.raws)
    case 'sheet':
      return saveSheet(st, op.name)
    case 'sources': {
      const names = Object.keys(st.sources).filter((n) => !st.pendingImport.includes(n))
      if (names.length) await must(sb.from('sources').upsert(names.map((name) => ({ name, is_master: st.master === name })), { onConflict: 'name' }), 'sheets')
      return
    }
    case 'log':
      for (const part of chunks(op.entries, 500))
        await must(sb.from('review_log').insert(part.map((l) => ({ source: l.source, raw_name: l.raw, decision: l.decision, model_key: l.canonicalId || null, decided_on: l.date }))), 'review log')
      return
    case 'merge':
      await must(sb.rpc('merge_models', { p_from: op.from, p_into: op.into }), 'merge')
      return
    case 'deleteModel':
      await must(sb.rpc('delete_model', { p_key: op.id }), 'delete model')
      return
    case 'deleteSource':
      await must(sb.rpc('delete_source', { p_name: op.name }), 'remove sheet')
      return
    case 'capture':
      if (st.canonicals.some((c) => c.id === op.id)) await pushCapture(st, op.id, op.name)
      return
  }
}

async function manufacturerIds(names: string[]): Promise<Map<string, string>> {
  const uniq = [...new Set(names.filter(Boolean))]
  if (!uniq.length) return new Map()
  const rows = await must(supabase!.from('manufacturers').upsert(uniq.map((name) => ({ name })), { onConflict: 'name' }).select('id,name'), 'manufacturers')
  return new Map((rows as any[]).map((r) => [r.name, r.id]))
}

const fullRow = (c: Canonical, mfr: Map<string, string>) => ({
  canonical_key: c.id,
  manufacturer_id: mfr.get(c.manufacturer) ?? null,
  model: c.model,
  generation: c.generation || null,
  line: c.line || null,
  family: c.family || null,
  device_type: c.deviceType || null,
  ppm: toInt(c.ppm),
  color: c.color || null,
  paper_size: c.paper || null,
  toner_family: c.toner || null,
  notes: c.notes || null,
  ...specColumns(c.spec),
})

/** Columns for just the given fields, so an edit never blanks anything else. */
function fieldColumns(c: Canonical, fields: (keyof Canonical)[], mfr: Map<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields)
    switch (f) {
      case 'manufacturer': out.manufacturer_id = mfr.get(c.manufacturer) ?? null; break
      case 'model': out.model = c.model; break
      case 'generation': out.generation = c.generation || null; break
      case 'line': out.line = c.line || null; break
      case 'family': out.family = c.family || null; break
      case 'deviceType': out.device_type = c.deviceType || null; break
      case 'ppm': out.ppm = toInt(c.ppm); break
      case 'color': out.color = c.color || null; break
      case 'paper': out.paper_size = c.paper || null; break
      case 'toner': out.toner_family = c.toner || null; break
      case 'notes': out.notes = c.notes || null; break
      case 'spec': Object.assign(out, specColumns(c.spec)); break
    }
  return out
}

async function saveModels(st: State, ids: string[], fields: (keyof Canonical)[] | 'all') {
  const sb = supabase!
  const cs = ids.map((id) => st.canonicals.find((c) => c.id === id)).filter((c): c is Canonical => !!c)
  if (!cs.length) return // deleted or merged away since
  const mfr = await manufacturerIds(cs.map((c) => c.manufacturer))
  if (fields === 'all') {
    // Spec-bearing and spec-less rows go in separate batches (see specColumns in cloud.ts).
    for (const part of [...chunks(cs.filter((c) => c.spec), 500), ...chunks(cs.filter((c) => !c.spec), 500)])
      await must(sb.from('models').upsert(part.map((c) => fullRow(c, mfr)), { onConflict: 'canonical_key' }), 'models')
    return
  }
  for (const c of cs) {
    const cols = fieldColumns(c, fields, mfr)
    if (!Object.keys(cols).length) continue
    const rows = await must(sb.from('models').update(cols).eq('canonical_key', c.id).select('id'), 'model')
    if (!(rows as any[]).length) await must(sb.from('models').upsert(fullRow(c, mfr), { onConflict: 'canonical_key' }), 'model')
  }
}

async function modelUuids(keys: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const part of chunks([...new Set(keys)], 200)) {
    const rows = await must(supabase!.from('models').select('id,canonical_key').in('canonical_key', part), 'models')
    for (const r of rows as any[]) out.set(r.canonical_key, r.id)
  }
  return out
}

/**
 * Save one sheet: its settings and names (all of them, or just `only`), their variants, and, for
 * a whole-sheet save, its prices. A toner sheet's links are reconciled whole either way (a name
 * linked, unlinked or relinked changes which models its toners belong to). Mirrors push().
 */
async function saveSheet(st: State, name: string, only?: string[]) {
  const sb = supabase!
  const s = st.sources[name]
  if (!s || st.pendingImport.includes(name)) return // removed since, or still being previewed
  const [srcRow] = await must(
    sb.from('sources').upsert(
      { name, is_master: st.master === name, column_roles: s.roles, ...(only ? {} : { last_imported_at: new Date().toISOString() }) },
      { onConflict: 'name' }
    ).select('id'),
    'sheet'
  )
  const sid = (srcRow as any).id as string
  const pick = only ? new Set(only) : null
  const rows = pick ? s.rows.filter((r) => pick.has(r.raw)) : s.rows
  const hasToners = sourceHasToners(s)
  const linkOf = (r: Row) => st.links[linkKey(name, r.raw)]
  const target = (r: Row) => { const l = linkOf(r); return l && l !== IGNORE ? l : '' }
  const mid = await modelUuids((hasToners ? s.rows : rows).map(target).filter(Boolean))

  // Variants (FDW, DN, ...) of the linked names.
  const rowVariant = new Map<Row, string>()
  const pairs = new Map<string, { model_id: string; variant: string }>()
  for (const r of rows) {
    const m = mid.get(target(r))
    if (!m) continue
    const v = parse(r.raw, rowCtx(s, r)).variant
    if (!v) continue
    rowVariant.set(r, v)
    pairs.set(`${m}|${v}`, { model_id: m, variant: v })
  }
  const variantId = new Map<string, string>()
  for (const part of chunks([...pairs.values()], 500)) {
    const vr = await must(sb.from('model_variants').upsert(part, { onConflict: 'model_id,variant' }).select('id,model_id,variant'), 'variants')
    for (const r of vr as any[]) variantId.set(`${r.model_id}|${r.variant}`, r.id)
  }

  // Names.
  const aliasId = new Map<string, string>()
  const out = rows.map((r) => {
    const l = linkOf(r)
    const m = mid.get(target(r)) ?? null
    const v = rowVariant.get(r)
    return {
      source_id: sid,
      raw_name: r.raw,
      model_id: m,
      variant_id: m && v ? variantId.get(`${m}|${v}`) ?? null : null,
      status: l === IGNORE ? 'ignored' : m ? 'linked' : 'pending',
      row_count: r.count,
      attributes: Object.fromEntries(Object.entries(r.attrs).filter(([c]) => s.roles[c] !== 'ignore')),
    }
  })
  for (const part of chunks(out, 500)) {
    const ar = await must(sb.from('model_aliases').upsert(part, { onConflict: 'source_id,raw_name' }).select('id,raw_name'), 'names')
    for (const r of ar as any[]) aliasId.set(r.raw_name, r.id)
  }

  // Prices (whole-sheet saves only: a link change doesn't change a price, which hangs off the name).
  if (!only) {
    const priceCols = s.columns.filter((c) => s.roles[c] === 'price')
    if (priceCols.length) {
      const [pl] = await must(sb.from('price_lists').upsert({ source_id: sid, name }, { onConflict: 'source_id,name' }).select('id'), 'price list')
      const entries: object[] = []
      for (const r of s.rows) {
        const aid = aliasId.get(r.raw)
        if (!aid) continue
        for (const c of priceCols) {
          const price = toPrice(r.attrs[c] ?? '')
          if (price != null) entries.push({ price_list_id: (pl as any).id, alias_id: aid, price_type: c, price })
        }
      }
      for (const part of chunks(entries, 500)) await must(sb.from('price_entries').upsert(part, { onConflict: 'price_list_id,alias_id,price_type' }), 'prices')
    }
  }

  if (hasToners) await saveSheetToners(st, s.name, sid, mid)
}

/** A toner sheet's links mirror the sheet: add what its linked rows give, drop what they no longer do. */
async function saveSheetToners(st: State, name: string, sid: string, mid: Map<string, string>) {
  const sb = supabase!
  const s = st.sources[name]
  const supplyRows = new Map<string, { sku: string; color: string; supply_type: string; yield_pages: number | null; cost: number | null; description: string }>()
  const pairs = new Map<string, { model_id: string; sku: string; cost: number | null; yield_pages: number | null }>()
  for (const r of s.rows) {
    const l = st.links[linkKey(name, r.raw)]
    const m = l && l !== IGNORE ? mid.get(l) : undefined
    if (!m) continue
    for (const t of extractToners(s, r)) {
      const sku = skuKey(t.sku)
      if (!sku) continue
      if (!supplyRows.has(sku)) supplyRows.set(sku, { sku, color: t.color || 'unknown', supply_type: t.type, yield_pages: t.yieldPages, cost: t.cost, description: t.raw || t.sku })
      if (!pairs.has(`${m}|${sku}`)) pairs.set(`${m}|${sku}`, { model_id: m, sku, cost: t.cost, yield_pages: t.yieldPages })
    }
  }
  const supplyId = new Map<string, string>()
  for (const part of chunks([...supplyRows.values()], 500)) {
    const rows = await must(sb.from('supplies').upsert(part, { onConflict: 'sku' }).select('id,sku'), 'supplies')
    for (const r of rows as any[]) supplyId.set(r.sku, r.id)
  }
  const links = [...pairs.values()]
    .map((p) => ({ model_id: p.model_id, supply_id: supplyId.get(p.sku)!, source_id: sid, cost: p.cost, yield_pages: p.yield_pages }))
    .filter((r) => r.supply_id)
  for (const part of chunks(links, 500)) await must(sb.from('model_supplies').upsert(part, { onConflict: 'model_id,supply_id' }), 'toner links')

  const keep = new Set(links.map((r) => `${r.model_id}|${r.supply_id}`))
  const stale: { model_id: string; supply_id: string }[] = []
  for (let from = 0; ; from += 1000) {
    const rows = await must(sb.from('model_supplies').select('model_id,supply_id').eq('source_id', sid).order('model_id').order('supply_id').range(from, from + 999), 'toner links')
    for (const r of rows as any[]) if (!keep.has(`${r.model_id}|${r.supply_id}`)) stale.push(r)
    if ((rows as any[]).length < 1000) break
  }
  const byModel = new Map<string, string[]>()
  for (const r of stale) byModel.set(r.model_id, [...(byModel.get(r.model_id) ?? []), r.supply_id])
  for (const [m, sids] of byModel) await must(sb.from('model_supplies').delete().eq('model_id', m).in('supply_id', sids), 'remove toner link')
  for (const part of chunks([...new Set(stale.map((r) => r.supply_id))], 200)) {
    const still = new Set(((await must(sb.from('model_supplies').select('supply_id').in('supply_id', part), 'supply check')) as any[]).map((r) => r.supply_id))
    const orphans = part.filter((id) => !still.has(id))
    if (orphans.length) await must(sb.from('supplies').delete().in('id', orphans), 'remove unused supplies')
  }
}
