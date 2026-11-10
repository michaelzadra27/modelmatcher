import { useSyncExternalStore } from 'react'
import { Group, Member, isSure, proposeGroups, reconcile, sureTarget } from './match'
import { Canonical, DeviceSpec, IGNORE, LogEntry, Role, State, SupplyRec, emptyState, fmtId, linkKey } from './types'
import { importFile } from './workbook'
import { idbGet, idbSet } from './idb'

const KEY = 'modelmaster.v1'

let state: State = emptyState()
export const getState = () => state
const listeners = new Set<() => void>()
let saveTimer: number | undefined
/** Link keys the latest import set automatically, so it can be undone. */
let lastAuto: string[] = []

/**
 * Load the saved working state from IndexedDB (call once before rendering). A state still sitting in
 * localStorage from older versions is moved over, then removed so it can't go stale.
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
      /* unreadable legacy copy: start empty, Pull restores from the cloud */
    }
  }
  if (saved) state = { ...emptyState(), ...saved }
}

// Save failures are surfaced in the UI instead of being swallowed.
let saveError = ''
const errListeners = new Set<() => void>()
export function useSaveError(): string {
  return useSyncExternalStore(
    (cb) => {
      errListeners.add(cb)
      return () => errListeners.delete(cb)
    },
    () => saveError
  )
}
function setSaveError(msg: string) {
  if (msg === saveError) return
  saveError = msg
  errListeners.forEach((l) => l())
}

function persist() {
  window.clearTimeout(saveTimer)
  saveTimer = undefined
  idbSet(KEY, state).then(
    () => setSaveError(''),
    (e) => setSaveError(`Couldn't save your work in this browser (${(e as Error)?.message ?? e}). Push to the cloud or export the workbook so nothing is lost.`)
  )
}
// Flush a pending save when the tab is hidden or closed.
window.addEventListener('pagehide', () => saveTimer !== undefined && persist())
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && saveTimer !== undefined && persist())

function set(next: State) {
  state = next
  listeners.forEach((l) => l())
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(persist, 400)
}

export function useModelState(): State {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state
  )
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

/** Mint a canonical model with the next immutable MM-###### id. */
function create(s: State, draft: Group['draft']): { s: State; id: string } {
  const id = fmtId(s.nextId)
  return { s: { ...s, nextId: s.nextId + 1, canonicals: [...s.canonicals, { id, ...draft }] }, id }
}

export const actions = {
  /** Import workbooks, then link every name that surely matches a known model. `auto` = how many (undoable). */
  async importFiles(files: File[]): Promise<{ msg: string; auto: number }> {
    const msgs: string[] = []
    const autoKeys: string[] = []
    for (const f of files) {
      try {
        const r = await importFile(f, state)
        set(r.state)
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

  /** Take back the links the latest import made automatically (they return to the Inbox). */
  undoAutoLinks(): number {
    const keys = new Set(lastAuto.filter((k) => state.links[k] && state.links[k] !== IGNORE))
    lastAuto = []
    if (!keys.size) return 0
    const links = Object.fromEntries(Object.entries(state.links).filter(([k]) => !keys.has(k)))
    const log = state.log.filter((l) => !(l.decision === 'auto-linked' && keys.has(linkKey(l.source, l.raw))))
    set({ ...state, links, log })
    return keys.size
  },

  /** Make a source the authoritative model list: one canonical model per group of its names. */
  buildMaster(name: string): { created: number; flagged: number } {
    const src = state.sources[name]
    set({ ...state, master: name })
    const groups = proposeGroups({ ...state, sources: { [name]: src } })
    const ok = groups.filter((g) => g.existingId || !g.attention.length)
    actions.approveMany(ok)
    return { created: ok.filter((g) => !g.existingId).length, flagged: groups.length - ok.length }
  },

  clearMaster() {
    set({ ...state, master: '' })
  },

  /**
   * Link names that surely match a known model, no human needed: the same text was linked before,
   * or exactly one model shares the model number. Returns the link keys it set.
   */
  autoResolve(): string[] {
    const items = reconcile(state).filter((r) => isSure(r) && sureTarget(r))
    if (!items.length) return []
    set(items.reduce((s, r) => link(s, [{ source: r.source, raw: r.raw }], sureTarget(r), 'auto-linked'), state))
    return items.map((r) => linkKey(r.source, r.raw))
  },

  /** Confirm a batch of reconcile matches: each name → the canonical model the user picked. */
  confirmMatches(items: { source: string; raw: string; canonicalId: string }[]) {
    set(items.reduce((s, i) => link(s, [i], i.canonicalId, 'matched'), state))
  },

  setRole(source: string, col: string, role: Role) {
    const s = state.sources[source]
    set({ ...state, sources: { ...state.sources, [source]: { ...s, roles: { ...s.roles, [col]: role } } } })
  },

  /** Create a canonical model (or reuse the group's existing one) and link the chosen members to it. */
  approve(group: Group, draft: Group['draft'], members: Member[]) {
    let s = state
    let id = group.existingId
    if (!id) {
      const r = create(s, draft)
      s = r.s
      id = r.id
    }
    set(link(s, members, id, group.existingId ? 'linked' : 'created'))
  },

  linkTo(members: Pick<Member, 'source' | 'raw'>[], canonicalId: string) {
    set(link(state, members, canonicalId, 'merged'))
  },

  ignore(members: Pick<Member, 'source' | 'raw'>[]) {
    set(link(state, members, IGNORE, 'ignored'))
  },

  approveMany(groups: Group[]) {
    let s = state
    for (const g of groups) {
      let id = g.existingId
      if (!id) {
        const r = create(s, g.draft)
        s = r.s
        id = r.id
      }
      s = link(s, g.members, id, g.existingId ? 'auto-linked' : 'created')
    }
    set(s)
  },

  /** Save a BLI capture: attach the spec (and supplies) to an existing model, or create a new one. */
  saveCapture(opts: { modelId: string | null; identity: Omit<Canonical, 'id' | 'spec'>; spec: DeviceSpec; supplies: SupplyRec[]; name: string }): string {
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
    set({
      ...s,
      sources: { ...s.sources, [capName]: { ...src, rows } },
      links: opts.name ? { ...s.links, [linkKey(capName, opts.name)]: id } : s.links,
      capturedSupplies: { ...s.capturedSupplies, [id]: opts.supplies },
      log: [...s.log, { date: today(), source: capName, raw: opts.name, decision: 'bli-capture', canonicalId: id }],
    })
    return id
  },

  updateCanonical(id: string, patch: Partial<Canonical>) {
    set({ ...state, canonicals: state.canonicals.map((c) => (c.id === id ? { ...c, ...patch } : c)) })
  },

  unlink(source: string, raw: string) {
    const links = { ...state.links }
    delete links[linkKey(source, raw)]
    set({ ...state, links })
  },

  deleteCanonical(id: string) {
    const links = Object.fromEntries(Object.entries(state.links).filter(([, v]) => v !== id))
    set({ ...state, canonicals: state.canonicals.filter((c) => c.id !== id), links, deleted: [...state.deleted, id] })
  },

  /**
   * Fold one canonical model into another. All its names move over, and the retired id is kept
   * as a redirect so anything that stored it still resolves to the survivor.
   */
  mergeCanonicals(fromId: string, intoId: string) {
    if (fromId === intoId) return
    const links = Object.fromEntries(Object.entries(state.links).map(([k, v]) => [k, v === fromId ? intoId : v]))
    const redirects = Object.fromEntries(Object.entries(state.redirects).map(([k, v]) => [k, v === fromId ? intoId : v]))
    redirects[fromId] = intoId
    set({
      ...state,
      links,
      redirects,
      canonicals: state.canonicals.filter((c) => c.id !== fromId),
      deleted: [...state.deleted, fromId],
      log: [...state.log, { date: today(), source: '', raw: '', decision: 'model-merged', canonicalId: `${fromId} → ${intoId}` }],
    })
  },

  /** Move some names out of a model into a brand-new one (same details; edit generation/line afterwards). Returns the new id. */
  splitAliases(fromId: string, names: { source: string; raw: string }[]): string | null {
    const from = state.canonicals.find((c) => c.id === fromId)
    if (!from || !names.length) return null
    const { id: _old, ...draft } = from
    const r = create(state, { ...draft, notes: draft.notes })
    set(link(r.s, names, r.id, `split from ${fromId}`))
    return r.id
  },

  removeSource(name: string) {
    const sources = { ...state.sources }
    delete sources[name]
    const links = Object.fromEntries(Object.entries(state.links).filter(([k]) => !k.startsWith(name + '\u0001')))
    set({ ...state, sources, links })
  },

  /** Replace everything with state pulled from the cloud. */
  replace(next: State) {
    set(next)
  },

  reset() {
    set(emptyState())
  },
}
