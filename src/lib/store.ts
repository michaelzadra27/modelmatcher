import { useSyncExternalStore } from 'react'
import { Group, Member, proposeGroups, reconcile } from './match'
import { Canonical, IGNORE, LogEntry, Role, State, emptyState, fmtId, linkKey } from './types'
import { importFile } from './workbook'

const KEY = 'modelmaster.v1'

function load(): State {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { ...emptyState(), ...JSON.parse(raw) }
  } catch {
    /* ignore */
  }
  return emptyState()
}

let state: State = load()
export const getState = () => state
const listeners = new Set<() => void>()
let saveTimer: number | undefined

function set(next: State) {
  state = next
  listeners.forEach((l) => l())
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state))
    } catch {
      /* storage full or blocked: the exported workbook is the real save */
    }
  }, 400)
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
  async importFiles(files: File[]): Promise<string> {
    const msgs: string[] = []
    for (const f of files) {
      try {
        const r = await importFile(f, state)
        set(r.state)
        msgs.push(r.summary)
        const auto = actions.autoResolve()
        if (auto) msgs.push(`${auto} names already matched a known alias and were linked automatically`)
      } catch (e) {
        msgs.push(`${f.name}: could not read (${(e as Error).message})`)
      }
    }
    return msgs.join('\n')
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

  /** Link names whose text already matches a confirmed alias (no human needed). Returns how many. */
  autoResolve(): number {
    const items = reconcile(state).filter((r) => r.bucket === 'resolved')
    if (!items.length) return 0
    set(
      items.reduce((s, r) => link(s, [{ source: r.source, raw: r.raw }], r.resolvedId!, 'auto-linked'), state)
    )
    return items.length
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

  linkTo(members: Member[], canonicalId: string) {
    set(link(state, members, canonicalId, 'merged'))
  },

  ignore(members: Member[]) {
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
