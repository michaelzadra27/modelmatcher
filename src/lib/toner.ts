// Structured toner / supply extraction.
//
// A "toner sheet" (Staples being the reference shape) pairs columns per cartridge:
//   SKU  ·  Cost ($)  ·  Yield (pages)  — once for black, once for the colour set.
// Tagging those columns with the toner roles lets us turn each device row into
// structured toner records {sku, colour, cost, yield} tied to the model's MM- key,
// instead of flattening everything into one string. Any future sheet matches this
// shape just by tagging its columns the same way.

import { Role, Row, Source, State, SupplyRec, linkKey } from './types'

export type Toner = SupplyRec

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

const UNSURE = /\?|CONFIRM|NOT IDENTIFIED|NOT CONFIRMED|CANNOT BE IDENTIFIED|SEE NOTE/i
const PARTLIKE = /^[A-Z0-9]+(-[A-Z0-9]+)*$/
const isPartNo = (t: string) => t.length >= 4 && PARTLIKE.test(t) && /\d/.test(t)
/** Epson's retail "-S" suffix (T502120-S, and the "420-S" tail in "T502220/320/420-S") is the same bottle. */
const epsonRetail = (t: string) => t.replace(/^((?:T\d{3})?\d{3})-S$/, '$1')

/**
 * Split a colour-cartridge cell into its C/M/Y part numbers, in that order, when the cell
 * spells them out; else [] (kept as one colour record — we never invent SKUs). Handles:
 *   "HP 124A Q6001A/Q6003A/Q6002A"                    full parts
 *   "Canon 046 C/M/Y (1249C001/1248C001/1247C001)"   parts listed in brackets
 *   "Xerox 106R01436/01437/01438", "Oki 45536415/14/13", "Epson 502 (T502220/320/420-S)"
 *                                                     shortened tails → inherit the first part's head
 *   "Kyocera TK-5282C/M/Y", "Lexmark C746A1CG/MG/YG"  colour-letter tails
 *   "Brother TN331 C/M/Y"                             Brother series + colour letter
 */
export function splitColor(cell: string): string[] {
  const up = cell.toUpperCase().trim()
  if (UNSURE.test(up)) return []
  const bracket = [...up.matchAll(/\(([^()]*\/[^()]*)\)/g)].map((m) => m[1]).find((s) => /\d/.test(s))
  const list = (bracket ?? up.replace(/\([^()]*\)/g, ' ')).replace(/\b(TONER|PRINT CARTRIDGES?|INK)\b/g, ' ')
  const segs = list.split('/').map((s) => epsonRetail(s.trim())).filter(Boolean)
  if (segs.length < 2) return []
  const words = segs[0].split(/\s+/)
  let head = words[words.length - 1]
  // "Brother TN331 C/M/Y": the series code sits before a lone colour letter.
  if (/^[CMY]$/.test(head) && words.length >= 2 && /^(TN|LC)-?\d+$/.test(words[words.length - 2])) head = words[words.length - 2] + head
  if (!isPartNo(head)) return []
  const out = [head]
  for (const seg of segs.slice(1, 3)) {
    const t = seg.split(/\s+/)[0]
    const part = t.length >= head.length ? t : head.slice(0, head.length - t.length) + t
    if (!isPartNo(part) || part === head || out.includes(part)) return []
    out.push(part)
  }
  return out.length === 3 ? out : []
}

const BRAND_WORD = /^(BROTHER|CANON|DELL|EPSON|HP|KONICA MINOLTA|KYOCERA|LEXMARK|OKI|RICOH|SAMSUNG|SHARP|TOSHIBA|XEROX)\s+/

/**
 * The part number in a black-cartridge cell, when the cell spells exactly one out:
 *   "Ricoh MP 301 / 305+ Black Toner (841984)" → 841984      (single part in brackets)
 *   "Oki 45536416 Black" → 45536416                           (brand + part + colour word)
 *   "Brother TN331 Black" → TN331BK on a colour model, "Brother TN830" → TN830
 * Anything uncertain or ambiguous is returned unchanged.
 */
export function blackPart(cell: string, colourModel: boolean): string {
  const up = cell.toUpperCase().trim()
  if (UNSURE.test(up)) return cell.trim()
  const inside = [...up.matchAll(/\(([^()]*)\)/g)].map((m) => m[1].trim())
  if (inside.length === 1 && isPartNo(inside[0]) && inside[0].length >= 6) return epsonRetail(inside[0])
  const bro = up.match(/^BROTHER\s+((?:TN|LC)-?\d+[A-Z]?)(\s+BLACK)?$/)
  if (bro) return bro[1] + (colourModel && bro[2] ? 'BK' : '')
  // Only when a brand word was there to strip: "PGI-2200 Black" / "GPR-39 Black" are series names, not parts.
  if (BRAND_WORD.test(up)) {
    const rest = up.replace(BRAND_WORD, '').replace(/\s+(BLACK|K)(\s+TONER)?$/, '').trim()
    if (isPartNo(rest) && rest.length >= 6) return rest
  }
  return cell.trim()
}

const COLORS = ['cyan', 'magenta', 'yellow']

/**
 * Epson's numbered ink series map to part numbers by a fixed scheme: T + series + colour digit
 * (1 black, 2 cyan, 3 magenta, 4 yellow) + "20" — "Epson 252 C/M/Y" → T252220/T252320/T252420.
 * Black is skipped on series that also have a photo black (PB), where the numbering differs.
 */
function epsonColor(cell: string): string[] {
  const m = cell.toUpperCase().trim().match(/^EPSON (\d{3}) C\/M\/Y(\/PB)?(\/GY)?$/)
  return m ? ['2', '3', '4'].map((d) => `T${m[1]}${d}20`) : []
}
function epsonBlack(cell: string, colorCell: string): string | undefined {
  const m = cell.toUpperCase().trim().match(/^EPSON (\d{3}) BLACK( INK)?$/)
  return m && !/\/PB\b/i.test(colorCell) ? `T${m[1]}120` : undefined
}

/** A cartridge name with its bracketed part numbers removed: "Canon 040 C/M/Y (0458C001/…)" → "CANON 040 C/M/Y". */
const nameKey = (cell: string) => cell.toUpperCase().replace(/\([^()]*\)/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * Part numbers a sheet spells out on one row, reusable on rows that give only the name:
 * one row says "Canon 040 C/M/Y (0458C001/0456C001/0454C001)", another just "Canon 040 C/M/Y".
 */
const learnedCache = new WeakMap<Source, { black: Map<string, string>; color: Map<string, string[]> }>()
function learned(src: Source) {
  let k = learnedCache.get(src)
  if (k) return k
  k = { black: new Map(), color: new Map() }
  const b = colOf(src, 'tonerBlackSku')
  const c = colOf(src, 'tonerColorSku')
  for (const r of src.rows) {
    const bc = b ? (r.attrs[b] ?? '').trim() : ''
    if (bc.includes('(')) {
      const p = blackPart(bc, true)
      if (p !== bc) k.black.set(nameKey(bc), p)
    }
    const cc = c ? (r.attrs[c] ?? '').trim() : ''
    if (cc.includes('(')) {
      const p = splitColor(cc)
      if (p.length) k.color.set(nameKey(cc), p)
    }
  }
  learnedCache.set(src, k)
  return k
}

/** Every toner implied by one device row, using the source's tagged toner columns. */
export function extractToners(src: Source, row: Row): Toner[] {
  const get = (role: Role) => {
    const c = colOf(src, role)
    return c ? (row.attrs[c] ?? '').trim() : ''
  }
  const out: Toner[] = []

  const blackSku = get('tonerBlackSku')
  const colorCell = get('tonerColorSku')
  const known = learned(src)
  if (!NA(blackSku)) {
    let sku = blackPart(blackSku, !NA(colorCell))
    if (sku === blackSku.trim()) sku = known.black.get(nameKey(blackSku)) ?? epsonBlack(blackSku, colorCell) ?? sku
    out.push({ sku, color: 'black', cost: num(get('tonerBlackCost')), yieldPages: toInt(get('tonerBlackYield')), type: 'toner', raw: blackSku })
  }

  if (!NA(colorCell)) {
    const cost = num(get('tonerColorCost'))
    const y = toInt(get('tonerColorYield'))
    let parts = splitColor(colorCell)
    if (!parts.length) parts = known.color.get(nameKey(colorCell)) ?? epsonColor(colorCell)
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
