// Deterministic model-name parsing. No AI: the same input always yields the same key.
//
// A raw name like "HP LaserJet Pro M428fdw" is reduced to
//   manufacturer = HP, base = M428, variant = FDW
// so that "M428", "HP M428FDN" and "HP-M428-FDW" all land in the same group (HP|M428).

export interface Parsed {
  mfr: string // canonical manufacturer display name, '' if unknown
  base: string // identity of the model, e.g. M428
  variant: string // suffix that distinguishes variants, e.g. FDW
  key: string // mfrKey|base
  hasCore: boolean // false when no model-number-like token was found
  mfrFromHint: boolean
  line: string // product line (IR, IFORCE, LASERJET...), '' when the name does not say
  gen: string // generation marker: II, III, IV, '' when none
  mfrConflict: string // source column said this manufacturer, but the name itself names another
}

// Explicit brand words → canonical display name.
const BRANDS: [string, RegExp][] = [
  ['HP', /\b(HP|HEWLETT[- ]?PACKARD|LASERJET|DESIGNJET|OFFICEJET|PAGEWIDE|DESKJET|LATEX)\b/],
  ['Canon', /\b(CANON|IMAGERUNNER|IMAGEPRESS|IMAGEFORCE|IMAGECLASS|IMAGEPROGRAF|MAXIFY|PIXMA)\b/],
  ['Ricoh', /\b(RICOH|AFICIO|SAVIN|LANIER|NASHUATEC|GESTETNER|INFOPRINT)\b/],
  ['Brother', /\bBROTHER\b/],
  ['Lexmark', /\bLEXMARK\b/],
  ['Xerox', /\b(XEROX|VERSALINK|ALTALINK|WORKCENTRE|PHASER|DOCUCOLOR|PRIMELINK)\b/],
  ['Konica Minolta', /\b(KONICA|MINOLTA|BIZHUB|ACCURIO)/],
  ['Kyocera', /\b(KYOCERA|ECOSYS|TASKALFA|COPYSTAR)\b/],
  ['Epson', /\b(EPSON|SURECOLOR|WORKFORCE|ECOTANK)\b/],
  ['Sharp', /\bSHARP\b/],
  ['Samsung', /\bSAMSUNG\b/],
  ['Toshiba', /\b(TOSHIBA|E-?STUDIO)/],
  ['Zebra', /\bZEBRA\b/],
  ['Dell', /\bDELL\b/],
  ['Oce', /\bOC[EÉ]\b/],
  ['Fargo', /\bFARGO\b/],
  ['Troy', /\bTROY\b/],
  ['Lomond', /\bLOMOND\b/],
  ['OKI', /\bOKI(DATA)?\b/],
  ['Pantum', /\bPANTUM\b/],
  ['Panasonic', /\bPANASONIC\b/],
  ['Develop', /\bDEVELOP\b/],
  ['Muratec', /\b(MURATEC|UTAX|TRIUMPH[- ]ADLER)\b/],
]

// Model-prefix hints used only when no brand word is present.
const HINTS: [string, RegExp][] = [
  ['Canon', /^(IR|IPR|IP|LBP|MF)[ -]?[A-Z]?\d/],
  ['Ricoh', /^(IM|MP|SP)[ -]?[A-Z]?\d/],
  ['Brother', /^(HL|MFC|DCP)[ -]?[A-Z]?\d/],
  ['Kyocera', /^FS[ -]?\d/],
  ['Sharp', /^MX[ -]?[A-Z]?\d/],
  ['Epson', /^SC[ -]?[A-Z]\d/],
  ['Toshiba', /^E?[ -]?STUDIO/],
]

// Words that never identify a model.
const NOISE = new Set(
  `LASERJET LJ PRO ENTERPRISE COLOR COLOUR MFP MFD PRINTER PRINTERS COPIER SERIES IMAGERUNNER IMAGEPRESS
   IMAGEFORCE IMAGECLASS IMAGEPROGRAF ADVANCE ADV DX MONO LASER MULTIFUNCTION FLOW PRESS BIZHUB OFFICEJET
   DESIGNJET PAGEWIDE DESKJET ECOSYS TASKALFA VERSALINK ALTALINK WORKCENTRE PHASER AFICIO ACCURIO
   ACCURIOPRESS SURECOLOR WORKFORCE ECOTANK DIGITAL A3 A4 THE AND FOR WITH PS POSTSCRIPT WIFI WIRELESS
   NEW SECURITY NON LOCKING DRAWER`.split(/\s+/)
)

// Prefixes that may be fused to the model number ("IMC3510", "iR3235", "MP3352SP").
// Longest first. These are stripped so "IM C3510" and "IMC3510" agree.
const PREFIXES = ['STUDIO', 'ESTUDIO', 'ADV', 'IPR', 'MFC', 'DCP', 'IR', 'IP', 'IM', 'MP', 'SP', 'MX', 'HL', 'FS', 'SC']

function detectMfr(name: string, extra: string): { mfr: string; hint: boolean } {
  const up = name.toUpperCase()
  const ex = extra.toUpperCase()
  for (const [m, re] of BRANDS) if (re.test(up)) return { mfr: m, hint: false }
  for (const [m, re] of BRANDS) if (ex && re.test(ex)) return { mfr: m, hint: false }
  for (const [m, re] of HINTS) if (re.test(up)) return { mfr: m, hint: true }
  return { mfr: '', hint: false }
}

/** Map a free-text manufacturer value ("KONICA MINOLTA", "hp inc.") to its canonical display name. */
export function canonMfr(value: string): string {
  const v = value.trim()
  if (!v) return ''
  const up = v.toUpperCase()
  for (const [m, re] of BRANDS) if (re.test(up)) return m
  return v
}

export function mfrKey(m: string): string {
  return m ? m.toUpperCase().replace(/[^A-Z0-9]/g, '') : 'UNKNOWN'
}

// Product lines. A model number can be reused across lines (Canon imageFORCE 1643 vs iR1643i),
// so the line is part of a model's identity. Names that do not mention a line are wildcards.
const LINES: [string, RegExp][] = [
  ['IFORCE', /IMAGEFORCE/],
  ['ICLASS', /IMAGECLASS/],
  ['IPR', /IMAGEPRESS|\bIPR\b/],
  ['IPF', /\bIPF|\bPRO-\d/],
  ['IR', /IMAGERUNNER|\bIR(?![A-Z])/],
  ['MAXIFY', /MAXIFY/],
  ['PIXMA', /PIXMA/],
  ['LASERJET', /LASERJET|\bLJ\b/],
  ['DESIGNJET', /DESIGNJET/],
  ['PAGEWIDE', /PAGEWIDE/],
  ['OFFICEJET', /OFFICEJET/],
  ['DESKJET', /DESKJET/],
  ['LATEX', /\bLATEX\b/],
  ['BIZHUB', /BIZHUB/],
  ['ACCURIO', /ACCURIO/],
  ['WORKCENTRE', /WORKCENTRE|WORKCENTER/],
  ['VERSALINK', /VERSALINK/],
  ['ALTALINK', /ALTALINK/],
  ['PHASER', /PHASER/],
  ['ECOSYS', /ECOSYS/],
  ['TASKALFA', /TASKALFA/],
  ['AFICIO', /AFICIO/],
  ['SURECOLOR', /SURECOLOR/],
  ['WORKFORCE', /WORKFORCE/],
  ['ECOTANK', /ECOTANK/],
]

export function detectLine(...texts: string[]): string {
  for (const t of texts) {
    const up = t.toUpperCase()
    for (const [l, re] of LINES) if (re.test(up)) return l
  }
  return ''
}

const GENERATION = /^(II|III|IV)$/

function tokenize(s: string): string[] {
  return s
    .toUpperCase()
    .replace(/[™®©]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .split(/[\s\-_/,.+]+/)
    .filter(Boolean)
}

const hasDigit = (t: string) => /\d/.test(t)
const hasLetter = (t: string) => /[A-Z]/.test(t)

function stripPrefix(t: string): string {
  for (const p of PREFIXES) {
    if (t.length > p.length && t.startsWith(p)) {
      const rest = t.slice(p.length)
      if (hasDigit(rest) && /^[A-Z0-9]/.test(rest)) return rest
    }
  }
  return t
}

function parseName(
  name: string
): { base: string; variant: string; gen: string } | null {
  // Version strings like "v1.2.07" are not model numbers.
  const all = tokenize(name).filter((t) => !/^V\d+$/.test(t))
  const gen = all.find((t) => GENERATION.test(t)) ?? ''
  const tokens = all.filter((t) => !GENERATION.test(t))
  // Candidate tokens that contain a digit, ignoring noise words.
  const idx = tokens.findIndex((t) => hasDigit(t) && hasLetter(t) && !NOISE.has(t))
  const idxNum = idx >= 0 ? idx : tokens.findIndex((t) => hasDigit(t))
  if (idxNum < 0) return null
  const stripped = stripPrefix(tokens[idxNum])
  let core = stripped
  let rest = ''
  // A numeric-leading core ("255") keeps a short non-prefix letter token before it ("TM-255" → TM255).
  if (/^\d/.test(core) && stripped === tokens[idxNum] && idxNum > 0) {
    const prev = tokens[idxNum - 1]
    if (!hasDigit(prev) && prev.length <= 3 && !NOISE.has(prev) && !PREFIXES.includes(prev) && !BRANDS.some(([, re]) => re.test(prev))) core = prev + core
  }
  const m = core.match(/^([A-Z]*\d+)([A-Z0-9]*)$/)
  let base = core
  let variant = ''
  if (m) {
    base = m[1]
    variant = m[2]
  }
  // A short letters-only token right after the core ("M428 FDW") is part of the variant.
  const next = tokens[idxNum + 1]
  if (next && !hasDigit(next) && next.length <= 4 && !NOISE.has(next)) rest = next
  return { base, variant: variant + rest, gen }
}

export function parse(raw: string, opts: { mfr?: string; desc?: string } = {}): Parsed {
  const given = opts.mfr ? canonMfr(opts.mfr) : ''
  // A brand spelled out in the model name beats the manufacturer column (source columns can be wrong).
  const named = BRANDS.find(([, re]) => re.test(raw.toUpperCase()))?.[0] ?? ''
  const mfrConflict = given && named && given !== named ? given : ''
  const det = named ? { mfr: named, hint: false } : given ? { mfr: given, hint: false } : detectMfr(raw, opts.desc ?? '')
  let p = parseName(raw)
  if (!p && opts.desc) p = parseName(opts.desc)
  if (p) {
    return {
      mfr: det.mfr,
      base: p.base,
      variant: p.variant,
      key: `${mfrKey(det.mfr)}|${p.base}`,
      hasCore: true,
      mfrFromHint: det.hint,
      line: detectLine(raw, opts.desc ?? ''),
      gen: p.gen,
      mfrConflict,
    }
  }
  const compact = raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return { mfr: det.mfr, base: compact, variant: '', key: `${mfrKey(det.mfr)}|~${compact}`, hasCore: false, mfrFromHint: det.hint, line: '', gen: '', mfrConflict }
}

/** Loose text key for "have we seen this exact alias before" (level-1 match). */
export function textKey(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** Loose word tokens for fuzzy comparison, without brand/noise words. */
export function looseTokens(s: string): Set<string> {
  return new Set(s.toUpperCase().split(/[^A-Z0-9]+/).filter((t) => t.length >= 2 && !NOISE.has(t)))
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a) return b.length
  if (!b) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}
