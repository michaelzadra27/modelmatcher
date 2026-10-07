import * as XLSX from 'xlsx'
import { parse } from './normalize'
import { rowCtx } from './match'
import { Canonical, IGNORE, LogEntry, Role, Row, Source, State, emptyState, linkKey } from './types'

const MASTER_SHEETS = ['Canonical_Models', 'Aliases']

function guessRole(header: string): Role {
  const h = header.toLowerCase()
  if (/manufact|brand|make|vendor|oem/.test(h)) return 'manufacturer'
  if (/famil|series/.test(h)) return 'family'
  if (/device.?type|^type$|categor|class/.test(h)) return 'deviceType'
  if (/desc/.test(h)) return 'description'
  return 'linked'
}

const str = (v: unknown) => (v == null ? '' : String(v).trim())

/** Merge rows into a source, collapsing duplicates by name (case-insensitive). */
function addRows(src: Source, incoming: { raw: string; attrs: Record<string, string> }[]) {
  const idx = new Map(src.rows.map((r) => [r.raw.toLowerCase(), r]))
  for (const inc of incoming) {
    const k = inc.raw.toLowerCase()
    let row = idx.get(k)
    if (!row) {
      row = { raw: inc.raw, count: 0, attrs: {} }
      idx.set(k, row)
      src.rows.push(row)
    }
    row.count++
    for (const [c, v] of Object.entries(inc.attrs)) {
      if (!v) continue
      const have = row.attrs[c] ? row.attrs[c].split('; ') : []
      if (!have.includes(v)) row.attrs[c] = [...have, v].join('; ')
    }
  }
}

export interface ImportResult {
  state: State
  summary: string
}

export async function importFile(file: File, state: State): Promise<ImportResult> {
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
  if (MASTER_SHEETS.every((n) => wb.SheetNames.includes(n))) return importMaster(wb, state, file.name)

  const next: State = { ...state, sources: { ...state.sources } }
  const parts: string[] = []
  const base = file.name.replace(/\.[^.]+$/, '')
  for (const sheetName of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], { header: 1, defval: '', raw: false })
    if (aoa.length < 2) continue
    const headers = aoa[0].map(str)
    const columns = headers.slice(1).filter(Boolean)
    const name = wb.SheetNames.length === 1 && /\.csv$/i.test(file.name) ? base : sheetName
    const prev = next.sources[name]
    const src: Source = prev
      ? { ...prev, rows: prev.rows.map((r) => ({ ...r })), columns: [...prev.columns] }
      : { name, columns: [], roles: {}, rows: [] }
    for (const c of columns) {
      if (!src.columns.includes(c)) src.columns.push(c)
      if (!src.roles[c]) src.roles[c] = guessRole(c)
    }
    const before = src.rows.length
    const incoming = []
    for (const r of aoa.slice(1)) {
      const raw = str(r[0])
      if (!raw) continue
      const attrs: Record<string, string> = {}
      headers.forEach((h, i) => {
        if (i > 0 && h) attrs[h] = str(r[i])
      })
      incoming.push({ raw, attrs })
    }
    // Re-importing a source: counts restart from this file, existing names stay.
    for (const row of src.rows) row.count = 0
    addRows(src, incoming)
    src.rows = src.rows.filter((r) => r.count > 0 || next.links[linkKey(name, r.raw)])
    next.sources[name] = src
    parts.push(`${name}: ${src.rows.length} unique models (${src.rows.length - before} new)`)
  }
  return { state: next, summary: parts.join(' · ') || 'No data rows found' }
}

function importMaster(wb: XLSX.WorkBook, state: State, fileName: string): ImportResult {
  const next = emptyState()
  const sheet = <T extends object>(n: string) => (wb.Sheets[n] ? XLSX.utils.sheet_to_json<T>(wb.Sheets[n], { defval: '', raw: false }) : [])

  next.canonicals = sheet<Record<string, string>>('Canonical_Models').map((r) => ({
    id: str(r['Canonical ID']),
    manufacturer: str(r['Manufacturer']),
    model: str(r['Canonical Model']),
    family: str(r['Family']),
    deviceType: str(r['Device Type']),
    ppm: str(r['PPM']),
    color: str(r['Color']),
    paper: str(r['Paper Size']),
    toner: str(r['Toner Family']),
    notes: str(r['Notes']),
  })).filter((c) => c.id)

  for (const r of sheet<Record<string, string>>('Settings')) {
    const s = (next.sources[r['Source']] ??= { name: r['Source'], columns: [], roles: {}, rows: [] })
    s.columns.push(r['Column'])
    s.roles[r['Column']] = r['Role'] as Role
  }
  for (const r of sheet<Record<string, string>>('Aliases')) {
    const sn = str(r['Source'])
    const raw = str(r['Raw Model'])
    if (!sn || !raw) continue
    const s = (next.sources[sn] ??= { name: sn, columns: [], roles: {}, rows: [] })
    const attrs: Record<string, string> = {}
    for (const [h, v] of Object.entries(r)) {
      const m = h.match(/^(.*) \| (.*)$/)
      if (m && m[1] === sn && str(v)) {
        attrs[m[2]] = str(v)
        if (!s.columns.includes(m[2])) {
          s.columns.push(m[2])
          s.roles[m[2]] = guessRole(m[2])
        }
      }
    }
    s.rows.push({ raw, count: Number(r['Count']) || 1, attrs })
    const cid = str(r['Canonical ID'])
    if (cid) next.links[linkKey(sn, raw)] = cid === 'IGNORE' ? IGNORE : cid
  }
  next.log = sheet<Record<string, string>>('Review_Log').map((r) => ({
    date: str(r['Date']),
    source: str(r['Source']),
    raw: str(r['Raw Model']),
    decision: str(r['Decision']),
    canonicalId: str(r['Canonical ID']),
  }))
  // Keep any sources already loaded that the master does not know about.
  for (const [n, s] of Object.entries(state.sources)) if (!next.sources[n]) next.sources[n] = s
  return {
    state: next,
    summary: `Loaded master "${fileName}": ${next.canonicals.length} canonical models, ${Object.keys(next.links).length} aliases`,
  }
}

export function exportMaster(state: State): XLSX.WorkBook {
  const wb = XLSX.utils.book_new()
  const byId = new Map(state.canonicals.map((c) => [c.id, c]))

  // Aliases + per-canonical aggregates of linked data.
  const aliasRows: Record<string, string | number>[] = []
  const agg = new Map<string, { n: number; sources: Set<string>; linked: Map<string, Set<string>> }>()
  const aliasCols: string[] = []
  for (const s of Object.values(state.sources)) {
    for (const c of s.columns) if (s.roles[c] !== 'ignore') aliasCols.push(`${s.name} | ${c}`)
  }
  for (const s of Object.values(state.sources)) {
    for (const row of s.rows) {
      const link = state.links[linkKey(s.name, row.raw)]
      const ctx = rowCtx(s, row)
      const out: Record<string, string | number> = {
        Source: s.name,
        'Raw Model': row.raw,
        'Canonical ID': link === IGNORE ? 'IGNORE' : link ?? '',
        'Canonical Model': link && byId.get(link) ? `${byId.get(link)!.manufacturer} ${byId.get(link)!.model}`.trim() : '',
        Variant: parse(row.raw, ctx).variant,
        Count: row.count,
      }
      for (const c of s.columns) if (s.roles[c] !== 'ignore') out[`${s.name} | ${c}`] = row.attrs[c] ?? ''
      aliasRows.push(out)
      if (link && byId.has(link)) {
        const a = agg.get(link) ?? { n: 0, sources: new Set(), linked: new Map() }
        a.n++
        a.sources.add(s.name)
        for (const c of s.columns) {
          if (s.roles[c] !== 'linked' || !row.attrs[c]) continue
          const set = a.linked.get(c) ?? new Set()
          row.attrs[c].split('; ').forEach((v) => set.add(v))
          a.linked.set(c, set)
        }
        agg.set(link, a)
      }
    }
  }
  const linkedCols = [...new Set([...agg.values()].flatMap((a) => [...a.linked.keys()]))]

  const canonRows = state.canonicals.map((c: Canonical) => {
    const a = agg.get(c.id)
    const o: Record<string, string | number> = {
      'Canonical ID': c.id,
      Manufacturer: c.manufacturer,
      'Canonical Model': c.model,
      Family: c.family,
      'Device Type': c.deviceType,
      PPM: c.ppm,
      Color: c.color,
      'Paper Size': c.paper,
      'Toner Family': c.toner,
      Notes: c.notes,
      'Alias Count': a?.n ?? 0,
      Sources: a ? [...a.sources].join(', ') : '',
    }
    for (const lc of linkedCols) o[lc] = a?.linked.get(lc) ? [...a.linked.get(lc)!].join('; ') : ''
    return o
  })

  const canonHeader = ['Canonical ID', 'Manufacturer', 'Canonical Model', 'Family', 'Device Type', 'PPM', 'Color', 'Paper Size', 'Toner Family', 'Notes', 'Alias Count', 'Sources', ...linkedCols]
  const aliasHeader = ['Source', 'Raw Model', 'Canonical ID', 'Canonical Model', 'Variant', 'Count', ...aliasCols]
  const add = (name: string, rows: object[], header: string[]) => {
    const ws = XLSX.utils.json_to_sheet(rows, { header })
    ws['!cols'] = header.map((h) => ({ wch: Math.min(40, Math.max(12, h.length + 2)) }))
    ws['!freeze'] = { xSplit: 0, ySplit: 1 }
    XLSX.utils.book_append_sheet(wb, ws, name)
  }
  add('Canonical_Models', canonRows, canonHeader)
  add('Aliases', aliasRows, aliasHeader)
  add(
    'Review_Log',
    state.log.map((l: LogEntry) => ({ Date: l.date, Source: l.source, 'Raw Model': l.raw, Decision: l.decision, 'Canonical ID': l.canonicalId })),
    ['Date', 'Source', 'Raw Model', 'Decision', 'Canonical ID']
  )
  add(
    'Settings',
    Object.values(state.sources).flatMap((s) => s.columns.map((c) => ({ Source: s.name, Column: c, Role: s.roles[c] }))),
    ['Source', 'Column', 'Role']
  )
  return wb
}

export type { Row }
