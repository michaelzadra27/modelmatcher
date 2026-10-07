import { useSyncExternalStore } from 'react'
import { Group, Member, slug } from './match'
import { Canonical, IGNORE, LogEntry, Role, State, emptyState, linkKey } from './types'
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

export const actions = {
  async importFiles(files: File[]): Promise<string> {
    const msgs: string[] = []
    for (const f of files) {
      try {
        const r = await importFile(f, state)
        set(r.state)
        msgs.push(r.summary)
      } catch (e) {
        msgs.push(`${f.name}: could not read (${(e as Error).message})`)
      }
    }
    return msgs.join('\n')
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
      const baseId = slug(`${draft.manufacturer}-${draft.model}`) || 'MODEL'
      id = baseId
      for (let n = 2; s.canonicals.some((c) => c.id === id); n++) id = `${baseId}-${n}`
      s = { ...s, canonicals: [...s.canonicals, { id, ...draft }] }
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
    const created: Canonical[] = []
    for (const g of groups) {
      let id = g.existingId
      if (!id) {
        const baseId = slug(`${g.draft.manufacturer}-${g.draft.model}`) || 'MODEL'
        id = baseId
        for (let n = 2; s.canonicals.some((c) => c.id === id) || created.some((c) => c.id === id); n++) id = `${baseId}-${n}`
        created.push({ id, ...g.draft })
      }
      s = link({ ...s, canonicals: [...s.canonicals, ...created.splice(0)] }, g.members, id, g.existingId ? 'auto-linked' : 'created')
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
    set({ ...state, canonicals: state.canonicals.filter((c) => c.id !== id), links })
  },

  removeSource(name: string) {
    const sources = { ...state.sources }
    delete sources[name]
    const links = Object.fromEntries(Object.entries(state.links).filter(([k]) => !k.startsWith(name + '\u0001')))
    set({ ...state, sources, links })
  },

  reset() {
    set(emptyState())
  },
}
