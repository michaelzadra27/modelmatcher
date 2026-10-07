import { Parsed, canonMfr, levenshtein, mfrKey, parse, textKey } from './normalize'
import { Canonical, IGNORE, Row, Source, State, linkKey } from './types'

export interface RowCtx {
  mfr: string
  desc: string
  family: string
  deviceType: string
}

/** Pull the role-tagged attribute values out of a row. */
export function rowCtx(src: Source, row: Row): RowCtx {
  const pick = (role: string) =>
    src.columns
      .filter((c) => src.roles[c] === role)
      .map((c) => row.attrs[c] ?? '')
      .find(Boolean) ?? ''
  return { mfr: pick('manufacturer'), desc: pick('description'), family: pick('family'), deviceType: pick('deviceType') }
}

export interface Member {
  source: string
  raw: string
  count: number
  variant: string
  attrs: Record<string, string>
  columns: string[]
  ctx: RowCtx
}

export interface Group {
  id: string
  existingId: string | null // set when the group auto-matches a canonical model
  matchedBy: 'alias' | 'model' | null
  mfr: string
  base: string
  members: Member[]
  sources: string[]
  attention: string[] // reasons a human should look closely
  draft: Omit<Canonical, 'id'>
}

function mostCommon(values: string[]): string {
  const m = new Map<string, number>()
  for (const v of values) if (v) m.set(v, (m.get(v) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
}

function canonParsed(c: Canonical): Parsed {
  return parse(c.model, { mfr: c.manufacturer })
}

/** Group every unreviewed source row by manufacturer + model number. */
export function proposeGroups(state: State): Group[] {
  const canonByKey = new Map<string, string>()
  for (const c of state.canonicals) canonByKey.set(canonParsed(c).key, c.id)

  // Level 1: loose text of every alias already linked to a canonical model.
  const aliasText = new Map<string, string>()
  for (const s of Object.values(state.sources)) {
    for (const r of s.rows) {
      const l = state.links[linkKey(s.name, r.raw)]
      if (l && l !== IGNORE) aliasText.set(textKey(r.raw), l)
    }
  }

  type Item = { m: Member; p: Parsed }
  const items: Item[] = []
  for (const s of Object.values(state.sources)) {
    for (const r of s.rows) {
      if (state.links[linkKey(s.name, r.raw)]) continue
      const ctx = rowCtx(s, r)
      const p = parse(r.raw, { mfr: ctx.mfr, desc: ctx.desc })
      items.push({ m: { source: s.name, raw: r.raw, count: r.count, variant: p.variant, attrs: r.attrs, columns: s.columns, ctx }, p })
    }
  }

  // A bare "M428" with no manufacturer joins the one manufacturer known to own that model number.
  const owners = new Map<string, Set<string>>()
  const note = (p: Parsed) => {
    if (!p.mfr || !p.hasCore) return
    const set = owners.get(p.base) ?? new Set()
    set.add(p.mfr)
    owners.set(p.base, set)
  }
  items.forEach((i) => note(i.p))
  state.canonicals.forEach((c) => note(canonParsed(c)))

  const groups = new Map<string, Group & { _p: Parsed }>()
  for (const { m, p0 } of items.map((i) => ({ m: i.m, p0: i.p }))) {
    let p = p0
    let adopted = false
    if (!p.mfr && p.hasCore) {
      const set = owners.get(p.base)
      if (set && set.size === 1) {
        const mfr = [...set][0]
        p = { ...p, mfr, key: `${mfrKey(mfr)}|${p.base}` }
        adopted = true
      }
    }
    const byAlias = aliasText.get(textKey(m.raw)) ?? null
    const byModel = canonByKey.get(p.key) ?? null
    const existingId = byAlias ?? byModel
    const gid = existingId ? `C:${existingId}` : `N:${p.key}`
    let g = groups.get(gid)
    if (!g) {
      g = {
        id: gid,
        existingId,
        matchedBy: byAlias ? 'alias' : byModel ? 'model' : null,
        mfr: p.mfr,
        base: p.base,
        members: [],
        sources: [],
        attention: [],
        draft: { manufacturer: p.mfr, model: p.base, family: '', deviceType: '', ppm: '', color: '', paper: '', toner: '', notes: '' },
        _p: p,
      }
      groups.set(gid, g)
    }
    g.members.push(m)
    if (!p.hasCore && !g.attention.includes('No model number found')) g.attention.push('No model number found')
    if (!p.mfr && !g.attention.includes('Manufacturer unknown')) g.attention.push('Manufacturer unknown')
    if (adopted && !g.attention.includes('Manufacturer inferred from model number')) g.attention.push('Manufacturer inferred from model number')
    if (p.mfrConflict) {
      const msg = `Source says manufacturer "${p.mfrConflict}" but the name says ${p.mfr}`
      if (!g.attention.includes(msg)) g.attention.push(msg)
    }
    if (p.mfrFromHint && !g.attention.includes('Manufacturer guessed from model prefix')) g.attention.push('Manufacturer guessed from model prefix')
  }

  const out: Group[] = []
  for (const g of groups.values()) {
    g.sources = [...new Set(g.members.map((m) => m.source))]
    const types = [...new Set(g.members.map((m) => m.ctx.deviceType).filter(Boolean))]
    if (types.length > 1) g.attention.push(`Conflicting device types: ${types.join(', ')}`)
    const mfrTxt = g.mfr || mostCommon(g.members.map((m) => canonMfr(m.ctx.mfr)))
    g.draft.manufacturer = mfrTxt
    g.draft.model = g.base
    g.draft.family = mostCommon(g.members.map((m) => m.ctx.family)) || `${mfrTxt} ${g.base}`.trim()
    g.draft.deviceType = mostCommon(g.members.map((m) => m.ctx.deviceType))
    out.push(g)
  }
  return out.sort((a, b) => Number(a.attention.length > 0) - Number(b.attention.length > 0) || a.mfr.localeCompare(b.mfr) || a.base.localeCompare(b.base, undefined, { numeric: true }))
}

export interface Candidate {
  label: string
  score: number
  canonicalId?: string
  groupId?: string
}

/** Near-miss suggestions for a group: same manufacturer, similar model number. */
export function similar(g: Group, groups: Group[], canonicals: Canonical[]): Candidate[] {
  const out: Candidate[] = []
  const mk = mfrKey(g.mfr)
  const near = (base: string) => {
    if (!base || base === g.base) return 0
    const d = levenshtein(base, g.base)
    const max = Math.max(base.length, g.base.length)
    const prefix = base.startsWith(g.base) || g.base.startsWith(base)
    if (d > 2 && !prefix) return 0
    return Math.round((1 - d / max) * 100) / 100
  }
  for (const c of canonicals) {
    if (g.existingId === c.id) continue
    const p = canonParsed(c)
    if (mfrKey(p.mfr) !== mk) continue
    const s = near(p.base)
    if (s) out.push({ label: `${c.manufacturer} ${c.model}`, score: s, canonicalId: c.id })
  }
  for (const o of groups) {
    if (o.id === g.id || o.existingId || mfrKey(o.mfr) !== mk) continue
    const s = near(o.base)
    if (s) out.push({ label: `${o.mfr} ${o.base} (pending group)`, score: s, groupId: o.id })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 5)
}

export const slug = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '')
