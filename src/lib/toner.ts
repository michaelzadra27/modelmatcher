// Structured toner / supply extraction.
//
// A "toner sheet" (Staples being the reference shape) pairs columns per cartridge:
//   SKU  ·  Cost ($)  ·  Yield (pages)  — once for black, once for the colour set.
// Tagging those columns with the toner roles lets us turn each device row into
// structured toner records {sku, colour, cost, yield} tied to the model's MM- key,
// instead of flattening everything into one string. Any future sheet matches this
// shape just by tagging its columns the same way.

import { Role, Row, Source, State, linkKey } from './types'

export interface Toner {
  sku: string
  color: string // black | cyan | magenta | yellow | color
  cost: number | null
  yieldPages: number | null
  type: string // toner | ink | drum | supply
  raw: string // the original cell, kept for provenance
}

const NA = (s: string) => !s || /^n\/?a$/i.test(s.trim())

/** Parse "$48.79" or "1,200" → number; null when empty/non-numeric. */
export function num(s: string | undefined): number | null {
  if (!s) return null
  const n = parseFloat(String(s).replace(/[^\d.]/g, ''))
  return Number.isFinite(n) ? n : null
}
const toInt = (s: string | undefined): number | null => {
  const n = num(s)
  return n == null ? null : Math.round(n)
}

const colOf = (src: Source, role: Role): string | undefined => src.columns.find((c) => src.roles[c] === role)

/**
 * Split a colour-cartridge cell into its C/M/Y part numbers when it holds distinct ones
 * ("HP 124A Q6001A/Q6003A/Q6002A" → three), else [] (e.g. "Brother TN221 C/M/Y" shorthand,
 * which we keep as a single colour record rather than inventing SKUs).
 */
function splitColor(cell: string): string[] {
  const parts = cell.split('/').map((s) => s.trim()).filter((t) => /\d/.test(t))
  return parts.length >= 2 ? parts.slice(0, 3) : []
}

const COLORS = ['cyan', 'magenta', 'yellow']

/** Every toner implied by one device row, using the source's tagged toner columns. */
export function extractToners(src: Source, row: Row): Toner[] {
  const get = (role: Role) => {
    const c = colOf(src, role)
    return c ? (row.attrs[c] ?? '').trim() : ''
  }
  const out: Toner[] = []

  const blackSku = get('tonerBlackSku')
  if (!NA(blackSku))
    out.push({ sku: blackSku, color: 'black', cost: num(get('tonerBlackCost')), yieldPages: toInt(get('tonerBlackYield')), type: 'toner', raw: blackSku })

  const colorCell = get('tonerColorSku')
  if (!NA(colorCell)) {
    const cost = num(get('tonerColorCost'))
    const y = toInt(get('tonerColorYield'))
    const parts = splitColor(colorCell)
    if (parts.length) parts.forEach((p, i) => out.push({ sku: p, color: COLORS[i] ?? 'color', cost, yieldPages: y, type: 'toner', raw: colorCell }))
    else out.push({ sku: colorCell, color: 'color', cost, yieldPages: y, type: 'toner', raw: colorCell })
  }

  // Generic "supply" columns (a plain SKU list, no cost/yield pairing).
  for (const c of src.columns)
    if (src.roles[c] === 'supply')
      for (const sku of (row.attrs[c] ?? '').split(/[;,\n]+/).map((s) => s.trim()).filter(Boolean))
        if (!NA(sku)) out.push({ sku, color: '', cost: null, yieldPages: null, type: 'supply', raw: sku })

  return out
}

export const sourceHasToners = (src: Source): boolean =>
  src.columns.some((c) => src.roles[c] === 'tonerBlackSku' || src.roles[c] === 'tonerColorSku' || src.roles[c] === 'supply')

/**
 * Expand a column-A cell that packs several models into one string.
 *   "Canon D1150/D1170"        → ["Canon D1150", "Canon D1170"]
 *   "Canon LBP245/246/248 II"  → ["Canon LBP245", "Canon LBP246", "Canon LBP248 II"]
 * Bare trailing segments inherit the first segment's brand + letter prefix. Only splits
 * when every segment carries a model number, so paper sizes etc. are left alone.
 */
export function expandModelNames(raw: string): string[] {
  const segs = raw.split(/[/,]/).map((s) => s.trim()).filter(Boolean)
  if (segs.length < 2 || !segs.every((s) => /\d/.test(s)) || segs.length > 4) return [raw]
  const first = segs[0]
  const m = first.match(/^(.*?)([A-Za-z]*\d.*)$/)
  const prefix = m ? m[1] : '' // brand + line words, e.g. "Canon "
  const letterPrefix = m ? m[2].match(/^([A-Za-z]+)/)?.[1] ?? '' : '' // model letters, e.g. "LBP"
  const brand = prefix.trim().split(/\s+/)[0] ?? ''
  const out = [first]
  for (let i = 1; i < segs.length; i++) {
    const s = segs[i]
    if (brand && s.toUpperCase().startsWith(brand.toUpperCase())) out.push(s)
    else if (/^\d/.test(s)) out.push(prefix + letterPrefix + s)
    else out.push(prefix + s)
  }
  return [...new Set(out)]
}

/** Live toners for one canonical model, deduped by sku+colour — for the Master editor preview. */
export function tonersForModel(state: State, id: string): Toner[] {
  const seen = new Map<string, Toner>()
  for (const s of Object.values(state.sources)) {
    if (!sourceHasToners(s)) continue
    for (const r of s.rows) {
      if (state.links[linkKey(s.name, r.raw)] !== id) continue
      for (const t of extractToners(s, r)) {
        const k = `${t.sku}\u0001${t.color}`
        if (!seen.has(k)) seen.set(k, t)
      }
    }
  }
  return [...seen.values()]
}
