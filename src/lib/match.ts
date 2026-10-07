import { Parsed, canonMfr, levenshtein, looseTokens, mfrKey, parse, textKey } from './normalize'
import { Canonical, IGNORE, Row, Source, State, linkKey, modelLabel } from './types'

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
  existingId: string | null // set when the group matches a canonical model
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

/** A canonical model's identity as a parse result: its own line/generation fields win. */
function canonParsed(c: Canonical): Parsed {
  const p = parse(c.model, { mfr: c.manufacturer })
  return { ...p, line: c.line ?? '', gen: c.generation ?? '' }
}

/** Same line, or at least one side does not say (a wildcard). */
const lineCompat = (a: string, b: string) => !a || !b || a === b

type Item = { m: Member; p: Parsed }
type Canon = { c: Canonical; p: Parsed; tokens: Set<string> }

function indexCanon(canonicals: Canonical[]): Canon[] {
  return canonicals.map((c) => ({ c, p: canonParsed(c), tokens: looseTokens(`${c.family} ${c.model}`) }))
}

/** The single canonical model with this exact manufacturer + number + generation (line may be unspecified). */
function uniqueIdentity(p: Parsed, canon: Canon[]): string | null {
  if (!p.hasCore) return null
  const hits = canon.filter((x) => x.p.hasCore && x.p.key === p.key && x.p.gen === p.gen && lineCompat(x.p.line, p.line))
  return hits.length === 1 ? hits[0].c.id : null
}

/** Group every unreviewed source row by manufacturer + model number + generation + product line. */
export function proposeGroups(state: State): Group[] {
  const canon = indexCanon(state.canonicals)

  // Level 1: loose text of every alias already linked to a canonical model.
  const aliasText = new Map<string, string>()
  for (const s of Object.values(state.sources)) {
    for (const r of s.rows) {
      const l = state.links[linkKey(s.name, r.raw)]
      if (l && l !== IGNORE) aliasText.set(textKey(r.raw), l)
    }
  }

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
  canon.forEach((x) => note(x.p))

  type Entry = { m: Member; p: Parsed; adopted: boolean }
  type Draft = { existingId: string | null; matchedBy: Group['matchedBy']; items: Entry[] }
  const existing = new Map<string, Draft>()
  const pools = new Map<string, Draft>() // mfr|base|gen → pending names, split by line below

  for (const { m, p: p0 } of items) {
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
    const byModel = byAlias ? null : uniqueIdentity(p, canon)
    const existingId = byAlias ?? byModel
    if (existingId) {
      const d = existing.get(existingId) ?? { existingId, matchedBy: byAlias ? ('alias' as const) : ('model' as const), items: [] }
      d.items.push({ m, p, adopted })
      existing.set(existingId, d)
    } else {
      const pk = `${p.key}|${p.gen}`
      const d = pools.get(pk) ?? { existingId: null, matchedBy: null, items: [] }
      d.items.push({ m, p, adopted })
      pools.set(pk, d)
    }
  }

  // Split each pending pool by product line. Names that do not state a line join the biggest line.
  const drafts: { id: string; d: Draft; line: string; mixed: boolean }[] = []
  for (const [id, d] of existing) drafts.push({ id: `C:${id}`, d, line: '', mixed: false })
  for (const [pk, d] of pools) {
    const lines = new Map<string, Entry[]>()
    for (const it of d.items) if (it.p.line) lines.set(it.p.line, [...(lines.get(it.p.line) ?? []), it])
    if (lines.size <= 1) {
      drafts.push({ id: `N:${pk}`, d, line: [...lines.keys()][0] ?? '', mixed: false })
      continue
    }
    const blank = d.items.filter((it) => !it.p.line)
    const biggest = [...lines.entries()].sort((a, b) => b[1].length - a[1].length)[0][0]
    for (const [line, its] of lines)
      drafts.push({
        id: `N:${pk}|${line}`,
        d: { existingId: null, matchedBy: null, items: line === biggest ? [...its, ...blank] : its },
        line,
        mixed: line === biggest && blank.length > 0,
      })
  }

  const out: Group[] = []
  for (const { id, d, line, mixed } of drafts) {
    const first = d.items[0].p
    const attention: string[] = []
    const add = (s: string) => attention.includes(s) || attention.push(s)
    for (const { p, adopted } of d.items) {
      if (!p.hasCore) add('No model number found')
      if (!p.mfr) add('Manufacturer unknown')
      if (adopted) add('Manufacturer inferred from model number')
      if (p.mfrFromHint) add('Manufacturer guessed from model prefix')
      if (p.mfrConflict) add(`Source says manufacturer "${p.mfrConflict}" but the name says ${p.mfr}`)
    }
    if (mixed) add(`Some names do not state a product line; placed with ${line}`)
    const members = d.items.map((i) => i.m)
    const types = [...new Set(members.map((m) => m.ctx.deviceType).filter(Boolean))]
    if (types.length > 1) add(`Conflicting device types: ${types.join(', ')}`)
    const mfr = first.mfr || mostCommon(members.map((m) => canonMfr(m.ctx.mfr)))
    out.push({
      id,
      existingId: d.existingId,
      matchedBy: d.matchedBy,
      mfr,
      base: first.base,
      members,
      sources: [...new Set(members.map((m) => m.source))],
      attention,
      draft: {
        manufacturer: mfr,
        model: first.base,
        generation: first.gen,
        line,
        family: mostCommon(members.map((m) => m.ctx.family)) || `${mfr} ${first.base}`.trim(),
        deviceType: mostCommon(members.map((m) => m.ctx.deviceType)),
        ppm: '',
        color: '',
        paper: '',
        toner: '',
        notes: '',
      },
    })
  }
  return out.sort(
    (a, b) =>
      Number(a.attention.length > 0) - Number(b.attention.length > 0) ||
      a.mfr.localeCompare(b.mfr) ||
      a.base.localeCompare(b.base, undefined, { numeric: true }) ||
      a.draft.generation.localeCompare(b.draft.generation)
  )
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
    // Same number but a different generation/line is the most useful suggestion of all.
    const s = mfrKey(p.mfr) === mk && p.base === g.base ? 0.95 : mfrKey(p.mfr) === mk ? near(p.base) : 0
    if (s) out.push({ label: modelLabel(c), score: s, canonicalId: c.id })
  }
  for (const o of groups) {
    if (o.id === g.id || o.existingId || mfrKey(o.mfr) !== mk) continue
    const s = o.base === g.base ? 0.95 : near(o.base)
    if (s) out.push({ label: `${o.mfr} ${o.base} ${o.draft.generation} (pending group)`.replace(/ +/g, ' '), score: s, groupId: o.id })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 5)
}

/* ── Reconcile: match another source's names against the master model list ── */

export type Bucket = 'resolved' | 'confident' | 'review' | 'none'
export type Kind = 'exact' | 'truncation' | 'core' | 'contains' | 'fuzzy'

export interface RCandidate {
  id: string
  label: string
  kind: Kind
  score: number
  note?: string
}

export interface ReconRow {
  source: string
  raw: string
  count: number
  mfr: string
  variant: string
  bucket: Bucket
  candidates: RCandidate[]
  resolvedId?: string
}

const digitsOnly = (s: string) => s.replace(/\D/g, '')

function relate(rowBase: string, canonBase: string): { kind: Kind; score: number } | null {
  if (!rowBase || !canonBase) return null
  if (rowBase === canonBase) return { kind: 'exact', score: 1 }
  const [lo, hi] = rowBase.length <= canonBase.length ? [rowBase, canonBase] : [canonBase, rowBase]
  if (hi.startsWith(lo) && /^[A-Z]+$/.test(hi.slice(lo.length))) return { kind: 'truncation', score: 0.9 }
  const da = digitsOnly(rowBase)
  if (da && da === digitsOnly(canonBase)) return { kind: 'core', score: 0.7 }
  if (rowBase.includes(canonBase) || canonBase.includes(rowBase)) return { kind: 'contains', score: 0.5 }
  return null
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

/** Bucket every unreviewed name from the non-master sources against the existing canonical models. */
export function reconcile(state: State): ReconRow[] {
  const aliasText = new Map<string, string>()
  for (const s of Object.values(state.sources))
    for (const r of s.rows) {
      const l = state.links[linkKey(s.name, r.raw)]
      if (l && l !== IGNORE) aliasText.set(textKey(r.raw), l)
    }

  const canon = indexCanon(state.canonicals)
  const byMfr = new Map<string, Canon[]>()
  for (const x of canon) {
    const k = mfrKey(x.p.mfr)
    byMfr.set(k, [...(byMfr.get(k) ?? []), x])
  }

  const out: ReconRow[] = []
  for (const s of Object.values(state.sources)) {
    if (s.name === state.master) continue
    for (const r of s.rows) {
      if (state.links[linkKey(s.name, r.raw)]) continue
      const ctx = rowCtx(s, r)
      const p = parse(r.raw, { mfr: ctx.mfr, desc: ctx.desc })
      const base = { source: s.name, raw: r.raw, count: r.count, mfr: p.mfr, variant: p.variant }

      const hit = aliasText.get(textKey(r.raw))
      if (hit) {
        out.push({ ...base, bucket: 'resolved', candidates: [], resolvedId: hit })
        continue
      }
      const pool = p.mfr ? byMfr.get(mfrKey(p.mfr)) ?? [] : canon
      const found = new Map<string, RCandidate>()
      if (p.hasCore)
        for (const x of pool) {
          if (!x.p.hasCore) continue
          const rel = relate(p.base, x.p.base)
          if (!rel) continue
          // A different product line is a different model, even with the same number.
          if (!lineCompat(p.line, x.p.line)) continue
          let { score } = rel
          let note: string | undefined
          if (p.gen !== x.p.gen) {
            // Two stated generations that differ are different models; one unstated is a guess.
            if (p.gen && x.p.gen) continue
            score = Math.min(score, 0.75)
            note = x.p.gen ? `model is ${x.p.gen}, name does not say` : `name says ${p.gen}, model has none`
          }
          found.set(x.c.id, { id: x.c.id, label: modelLabel(x.c), kind: rel.kind, score, note })
        }
      const strongest = Math.max(0, ...[...found.values()].map((c) => c.score))
      if (strongest < 0.7) {
        const rt = looseTokens(r.raw)
        for (const x of pool) {
          if (found.has(x.c.id)) continue
          const f = jaccard(rt, x.tokens)
          if (f >= 0.34) found.set(x.c.id, { id: x.c.id, label: modelLabel(x.c), kind: 'fuzzy', score: Math.min(0.6, f) })
        }
      }
      const candidates = [...found.values()].sort((a, b) => b.score - a.score).slice(0, 8)
      let bucket: Bucket = 'none'
      if (candidates.length) {
        const unique = candidates[0].score >= 0.9 && (candidates.length === 1 || candidates[1].score < 0.9)
        bucket = unique ? 'confident' : 'review'
      }
      out.push({ ...base, bucket, candidates })
    }
  }
  return out
}
