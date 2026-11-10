// Normalize a supply "SKU" cell to its manufacturer part number, so the same cartridge from
// different sources ("W2020A" from BLI, "HP 414A W2020A" from a toner sheet) is one supply.
// Deliberately conservative: only when the text holds exactly one unambiguous part number;
// bundles ("C/M/Y"), series ("TN210 Black"), sets and placeholders are left exactly as written.
// MUST stay identical to mm_sku() in supabase/migrations/0006_sku_dedupe.sql (parity-tested).

const UNCERTAIN = /\?|CONFIRM|NOT IDENTIFIED|CANNOT BE IDENTIFIED|PRICED BY|\$/
const MULTI = /\b(COLORS|COLOURS|SET|SERIES|PACKS?|INKS)\b/
const PART = /^[A-Z0-9]+(-[A-Z0-9]+)*$/

const isPart = (t: string) => t.length >= 6 && PART.test(t) && /\d/.test(t)
/** Canon's regional "AA" suffix: 3018C005AA → 3018C005. */
const canonical = (p: string) => p.replace(/^(\d{4}[A-Z]\d{3})AA$/, '$1')

export function skuKey(raw: string): string {
  const text = (raw ?? '').trim()
  const up = text.toUpperCase()
  if (!up) return text
  if (isPart(up)) return canonical(up) // already a bare part number
  if (UNCERTAIN.test(up) || MULTI.test(up)) return text
  const inside = [...up.matchAll(/\(([^()]*)\)/g)].map((m) => m[1])
  const outside = up.replace(/\([^()]*\)/g, ' ').replace(/[()]/g, ' ')
  if (outside.includes('/')) return text
  const tokens = (s: string) => s.split(/[\s,;]+/).filter(Boolean)
  const ins = inside.flatMap(tokens).filter(isPart)
  const inPart = ins.length === 1 && !inside.some((s) => s.includes('/')) ? canonical(ins[0]) : null
  const outT = tokens(outside)
  const out = outT.filter(isPart)
  if (out.length > 1) return text
  if (out.length === 1) {
    // A colour after the code ("GPR-58 C", "TN-229V CMY") means it's a series name, not a part number.
    const after = outT.slice(outT.indexOf(out[0]) + 1)
    if (after.some((t) => COLOR.has(t))) return inPart ?? text
    return canonical(out[0])
  }
  return inPart ?? text
}

const COLOR = new Set(['BLACK', 'CYAN', 'MAGENTA', 'YELLOW', 'C', 'M', 'Y', 'K', 'BK', 'CMY', 'CMYK', 'COLOR', 'COLOUR'])
