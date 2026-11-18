import { useSyncExternalStore } from 'react'
import { Group, Member, isSure, proposeGroups, reconcile, sureTarget } from './match'
import { Canonical, DeviceSpec, IGNORE, LogEntry, Role, State, SupplyRec, emptyState, linkKey } from './types'
import { importFile } from './workbook'
import { idbGet, idbSet } from './idb'
import { cloudConfigured } from './cloud'
import { Op, bumpVersion, canWrite, enqueue, initSync, refresh, reserveKeys } from './sync'

/*
 * The local copy of the database. Every action changes it at once (the screen updates instantly)
 * and queues the same change for the cloud (sync.ts), which is the source of truth. Signed out,
 * the app is read-only: actions refuse and say so.
 */

const KEY = 'modelmaster.v1'

let state: State = emptyState()
export const getState = () => state
const listeners = new Set<() => void>()
let saveTimer: number | undefined
/** Link keys the latest import set automatically, so it can be undone. */
let lastAuto: string[] = []

/**
 * Load the cached copy from IndexedDB (call once before rendering), then start saving/refreshing.
 * A copy still sitting in localStorage from older versions is moved over, then removed.
 */
export async function hydrate(): Promise<void> {
  let saved = await idbGet<State>(KEY).catch(() => undefined)
  if (!saved) {
    try {
      const raw = localStorage.getItem(KEY)
      if (raw) {
        saved = JSON.parse(raw) as State
        await idbSet(KEY, saved)
        localStorage.removeItem(KEY)
      }
    } catch {
      /* unreadable legacy copy: start empty, the refresh restores from the cloud */
    }
  }
  if (saved) state = { ...emptyState(), ...saved }
  initSync(getState, (next) => set(next, true))
}

// Problems saving the cache (or a refused action) are shown in the UI instead of being swallowed.
let saveError = ''
const errListeners = new Set<() => void>()
export function useSaveError(): string {
  return useSyncExternalStore((cb) => (errListeners.add(cb), () => errListeners.delete(cb)), () => saveError)
}
function setSaveError(msg: string) {
  if (msg === saveError) return
  saveError = msg
  errListeners.forEach((l) => l())
}
let noticeTimer: number | undefined
function notice(msg: string) {
  setSaveError(msg)
  window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => saveError === msg && setSaveError(''), 6000)
}

function persist() {
  window.clearTimeout(saveTimer)
  saveTimer = undefined
  idbSet(KEY, state).then(
    () => saveError.startsWith("Couldn't save your work") && setSaveError(''),
    (e) => setSaveError(`Couldn't save your work in this browser (${(e as Error)?.message ?? e}). Changes still go to the cloud.`)
  )
}
// Flush a pending save when the tab is hidden or closed.
window.addEventListener('pagehide', () => saveTimer !== undefined && persist())
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && saveTimer !== undefined && persist())

/** `fromCloud`: the copy was just loaded from the cloud (not a local change). */
function set(next: State, fromCloud = false) {
  state = next
  if (!fromCloud) bumpVersion()
  listeners.forEach((l) => l())
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(persist, 400)
}

export function useModelState(): State {
  return useSyncExternalStore((cb) => (listeners.add(cb), () => listeners.delete(cb)), () => state)
}

/** Changes need a signed-in user (the database only accepts writes from one). */
function writable(): boolean {
  if (!cloudConfigured || canWrite()) return true
  notice('Read-only: sign in on the Account tab to make changes.')
  return false
}

/**
 * Apply a change locally and queue it for the cloud. Review-log entries the change appended are
 * sent too, except those about a sheet still being previewed (held until the import is saved).
 */
function commit(next: State, ops: Op[], opts: { sendLog?: boolean } = {}) {
  const added = next.log.length > state.log.length ? next.log.slice(state.log.length) : []
  const pend = new Set(next.pendingImport)
  const held = added.filter((l) => pend.has(l.source))
  const send = opts.sendLog === false ? [] : added.filter((l) => !pend.has(l.source))
  set(held.length ? { ...next, heldLog: [...next.heldLog, ...held] } : next)
  if (!cloudConfigured) return
  enqueue(...ops, ...(send.length ? [{ t: 'log', entries: send } as Op] : []))
}

/** One "names" change per sheet, skipping sheets still being previewed (they're saved whole later). */
function nameOps(s: State, members: Pick<Member, 'source' | 'raw'>[]): Op[] {
  const by = new Map<string, Set<string>>()
  for (const m of members) if (!s.pendingImport.includes(m.source)) (by.get(m.source) ?? by.set(m.source, new Set()).get(m.source)!).add(m.raw)
  return [...by].map(([source, raws]) => ({ t: 'names', source, raws: [...raws] }))
}

/** Make sure `n` new MM keys are reserved from the database (only when online and signed in). */
async function haveKeys(n: number) {
  if (!cloudConfigured || state.keyPool.length >= n) return
  const got = await reserveKeys(n - state.keyPool.length)
  set({ ...state, keyPool: [...state.keyPool, ...got] }, true)
}

const today = () => new Date().toISOString().slice(0, 10)

function link(s: State, members: Pick<Member, 'source' | 'raw'>[], target: string, decision: string): State {
  const links = { ...s.links }
  const log: LogEntry[] = [...s.log]
  for (const m of members) {
    links[linkKey(m.source, m.raw)] = target
    log.push({ date: today(), source: m.source, raw: m.raw, decision, canonicalId: target === IGNORE ? '' : target })
  }
  return { ...s, links, log }
}

/** Create a canonical model with the next reserved MM-###### key (call haveKeys first). */
function create(s: State, draft: Group['draft']): { s: State; id: string } {
  const [id, ...rest] = s.keyPool
  if (!id) throw new Error('No model key reserved (are you signed in?)')
  return { s: { ...s, keyPool: rest, canonicals: [...s.canonicals, { id, ...draft }] }, id }
}

export const actions = {
  /**
   * Import workbooks, then link every name that surely matches a known model. The imported sheets
   * stay in preview (this browser only) until saveImport() — or discardImport(). `auto` = how many
   * names were linked automatically (undoable).
   */
  async importFiles(files: File[]): Promise<{ msg: string; auto: number }> {
    if (!writable()) return { msg: 'Read-only: sign in to import.', auto: 0 }
    const msgs: string[] = []
    const autoKeys: string[] = []
    for (const f of files) {
      try {
        const before = state.sources
        const r = await importFile(f, state)
        const touched = Object.keys(r.state.sources).filter((n) => r.state.sources[n] !== before[n])
        set({ ...r.state, pendingImport: [...new Set([...r.state.pendingImport, ...touched])] })
        msgs.push(r.summary)
        autoKeys.push(...actions.autoResolve())
      } catch (e) {
        msgs.push(`${f.name}: could not read (${(e as Error).message})`)
      }
    }
    lastAuto = autoKeys
    if (autoKeys.length) msgs.push(`Linked ${autoKeys.length.toLocaleString()} names to models you already have.`)
    return { msg: msgs.join('\n'), auto: autoKeys.length }
  },

  /** Save the previewed import to the cloud: the sheets whole, then the review entries held for them. */
  saveImport() {
    if (!writable() || !state.pendingImport.length) return
    const sheets = state.pendingImport
    const held = state.heldLog
    set({ ...state, pendingImport: [], heldLog: [] })
    if (!cloudConfigured) return
    enqueue({ t: 'sources' }, ...sheets.map((name) => ({ t: 'sheet', name }) as Op), ...(held.length ? [{ t: 'log', entries: held } as Op] : []))
  },

  /** Throw the previewed import away by reloading this copy from the cloud. */
  async discardImport(): Promise<boolean> {
    lastAuto = []
    return refresh(true)
  },

  /** Take back the links the latest import made automatically (they return to the Inbox). */
  undoAutoLinks(): number {
    if (!writable()) return 0
    const keys = new Set(lastAuto.filter((k) => state.links[k] && state.links[k] !== IGNORE))
    lastAuto = []
    if (!keys.size) return 0
    const links = Object.fromEntries(Object.entries(state.links).filter(([k]) => !keys.has(k)))
    const drop = (l: LogEntry) => l.decision === 'auto-linked' && keys.has(linkKey(l.source, l.raw))
    const members = [...keys].map((k) => { const [source, raw] = k.split('\u0001'); return { source, raw } })
    commit({ ...state, links, log: state.log.filter((l) => !drop(l)), heldLog: state.heldLog.filter((l) => !drop(l)) }, nameOps(state, members))
    return keys.size
  },

  /** Make a source the authoritative model list: one canonical model per group of its names. */
  async buildMaster(name: string): Promise<{ created: number; flagged: number }> {
    if (!writable()) return { created: 0, flagged: 0 }
    const src = state.sources[name]
    commit({ ...state, master: name }, [{ t: 'sources' }])
    const groups = proposeGroups({ ...state, sources: { [name]: src } })
    const ok = groups.filter((g) => g.existingId || !g.attention.length)
    await actions.approveMany(ok)
    return { created: ok.filter((g) => !g.existingId).length, flagged: groups.length - ok.length }
  },

  clearMaster() {
    if (!writable()) return
    commit({ ...state, master: '' }, [{ t: 'sources' }])
  },

  /**
   * Link names that surely match a known model, no human needed: the same text was linked before,
   * or exactly one model shares the model number. Returns the link keys it set.
   */
  autoResolve(): string[] {
    const items = reconcile(state).filter((r) => isSure(r) && sureTarget(r))
    if (!items.length) return []
    commit(items.reduce((s, r) => link(s, [{ source: r.source, raw: r.raw }], sureTarget(r), 'auto-linked'), state), nameOps(state, items))
    return items.map((r) => linkKey(r.source, r.raw))
  },

  /** Confirm a batch of reconcile matches: each name → the canonical model the user picked. */
  confirmMatches(items: { source: string; raw: string; canonicalId: string }[]) {
    if (!writable()) return
    commit(items.reduce((s, i) => link(s, [i], i.canonicalId, 'matched'), state), nameOps(state, items))
  },

  setRole(source: string, col: string, role: Role) {
    if (!writable()) return
    const s = state.sources[source]
    const next = { ...state, sources: { ...state.sources, [source]: { ...s, roles: { ...s.roles, [col]: role } } } }
    commit(next, state.pendingImport.includes(source) ? [] : [{ t: 'sheet', name: source }])
  },

  /** Create a canonical model (or reuse the group's existing one) and link the chosen members to it. */
  async approve(group: Group, draft: Group['draft'], members: Member[]) {
    if (!writable()) return
    if (!group.existingId) await haveKeys(1)
    let s = state
    let id = group.existingId
    const ops: Op[] = []
    if (!id) {
      const r = create(s, draft)
      s = r.s
      id = r.id
      ops.push({ t: 'models', ids: [id], fields: 'all' })
    }
    commit(link(s, members, id, group.existingId ? 'linked' : 'created'), [...ops, ...nameOps(s, members)])
  },

  linkTo(members: Pick<Member, 'source' | 'raw'>[], canonicalId: string) {
    if (!writable()) return
    commit(link(state, members, canonicalId, 'merged'), nameOps(state, members))
  },

  ignore(members: Pick<Member, 'source' | 'raw'>[]) {
    if (!writable()) return
    commit(link(state, members, IGNORE, 'ignored'), nameOps(state, members))
  },

  async approveMany(groups: Group[]) {
    if (!writable()) return
    await haveKeys(groups.filter((g) => !g.existingId).length)
    let s = state
    const created: string[] = []
    for (const g of groups) {
      let id = g.existingId
      if (!id) {
        const r = create(s, g.draft)
        s = r.s
        id = r.id
        created.push(id)
      }
      s = link(s, g.members, id, g.existingId ? 'auto-linked' : 'created')
    }
    const models: Op[] = []
    for (let i = 0; i < created.length; i += 500) models.push({ t: 'models', ids: created.slice(i, i + 500), fields: 'all' })
    commit(s, [...models, ...nameOps(s, groups.flatMap((g) => g.members))])
  },

  /** Save a BLI capture: attach the spec (and supplies) to an existing model, or create a new one. */
  async saveCapture(opts: { modelId: string | null; identity: Omit<Canonical, 'id' | 'spec'>; spec: DeviceSpec; supplies: SupplyRec[]; name: string }): Promise<string | null> {
    if (!writable()) return null
    if (!opts.modelId) await haveKeys(1)
    let s = state
    let id = opts.modelId
    if (id) {
      const cur = id
      s = {
        ...s,
        canonicals: s.canonicals.map((c) => {
          if (c.id !== cur) return c
          // Fill only blank identity fields; the model's keyed identity wins.
          const merged = { ...c }
          for (const [k, v] of Object.entries(opts.identity)) if (!merged[k as keyof Canonical] && v) (merged as any)[k] = v
          return { ...merged, spec: opts.spec }
        }),
      }
    } else {
      const r = create(s, { ...opts.identity, spec: opts.spec })
      s = r.s
      id = r.id
    }
    // Record the device name as an alias under a synthetic source, so it resolves to this model.
    const capName = 'BLI Capture'
    const src = s.sources[capName] ?? { name: capName, columns: [], roles: {}, rows: [] }
    const rows = src.rows.some((r) => r.raw === opts.name) ? src.rows : [...src.rows, { raw: opts.name, count: 1, attrs: {} }]
    // The capture writes its own review-log entry in the cloud (pushCapture), so it isn't sent twice.
    commit(
      {
        ...s,
        sources: { ...s.sources, [capName]: { ...src, rows } },
        links: opts.name ? { ...s.links, [linkKey(capName, opts.name)]: id } : s.links,
        capturedSupplies: { ...s.capturedSupplies, [id]: opts.supplies },
        log: [...s.log, { date: today(), source: capName, raw: opts.name, decision: 'bli-capture', canonicalId: id }],
      },
      [{ t: 'capture', id, name: opts.name }],
      { sendLog: false }
    )
    return id
  },

  updateCanonical(id: string, patch: Partial<Canonical>) {
    if (!writable()) return
    commit({ ...state, canonicals: state.canonicals.map((c) => (c.id === id ? { ...c, ...patch } : c)) }, [{ t: 'models', ids: [id], fields: Object.keys(patch) as (keyof Canonical)[] }])
  },

  unlink(source: string, raw: string) {
    if (!writable()) return
    const links = { ...state.links }
    delete links[linkKey(source, raw)]
    commit({ ...state, links }, nameOps(state, [{ source, raw }]))
  },

  deleteCanonical(id: string) {
    if (!writable()) return
    const links = Object.fromEntries(Object.entries(state.links).filter(([, v]) => v !== id))
    commit({ ...state, canonicals: state.canonicals.filter((c) => c.id !== id), links }, [{ t: 'deleteModel', id }])
  },

  /**
   * Fold one canonical model into another. All its names move over, and the retired id is kept
   * as a redirect so anything that stored it still resolves to the survivor.
   */
  mergeCanonicals(fromId: string, intoId: string) {
    if (fromId === intoId || !writable()) return
    const links = Object.fromEntries(Object.entries(state.links).map(([k, v]) => [k, v === fromId ? intoId : v]))
    const redirects = Object.fromEntries(Object.entries(state.redirects).map(([k, v]) => [k, v === fromId ? intoId : v]))
    redirects[fromId] = intoId
    const capturedSupplies = { ...state.capturedSupplies }
    if (capturedSupplies[fromId] && !capturedSupplies[intoId]) capturedSupplies[intoId] = capturedSupplies[fromId]
    delete capturedSupplies[fromId]
    commit(
      {
        ...state,
        links,
        redirects,
        capturedSupplies,
        canonicals: state.canonicals.filter((c) => c.id !== fromId),
        log: [...state.log, { date: today(), source: '', raw: '', decision: 'model-merged', canonicalId: `${fromId} → ${intoId}` }],
      },
      [{ t: 'merge', from: fromId, into: intoId }]
    )
  },

  /** Move some names out of a model into a brand-new one (same details; edit generation/line afterwards). Returns the new id. */
  async splitAliases(fromId: string, names: { source: string; raw: string }[]): Promise<string | null> {
    const from = state.canonicals.find((c) => c.id === fromId)
    if (!from || !names.length || !writable()) return null
    await haveKeys(1)
    const { id: _old, ...draft } = state.canonicals.find((c) => c.id === fromId)!
    const r = create(state, { ...draft, notes: draft.notes })
    commit(link(r.s, names, r.id, `split from ${fromId}`), [{ t: 'models', ids: [r.id], fields: 'all' }, ...nameOps(r.s, names)])
    return r.id
  },

  removeSource(name: string) {
    if (!writable()) return
    const sources = { ...state.sources }
    delete sources[name]
    const links = Object.fromEntries(Object.entries(state.links).filter(([k]) => !k.startsWith(name + '\u0001')))
    const pending = state.pendingImport.includes(name)
    commit(
      { ...state, sources, links, pendingImport: state.pendingImport.filter((n) => n !== name), heldLog: state.heldLog.filter((l) => l.source !== name) },
      pending ? [] : [{ t: 'deleteSource', name }]
    )
  },

  /** Replace everything with state loaded from the cloud (refresh). */
  replace(next: State) {
    set(next, true)
  },

  /** Clear this browser's copy (the cloud is untouched); refresh reloads it. */
  reset() {
    set({ ...emptyState(), keyPool: state.keyPool }, true)
  },
}
